import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceAccess } from "../modules/types.js";

// DSH-style policy/provider seam. Unlike DSH's write-only profiles, this adapter
// also limits reads: private state and host credentials are never runtime mounts.
export const bubblewrapPath = "/usr/bin/bwrap";
const seatbeltPath = "/usr/bin/sandbox-exec";
const probeTimeoutMs = 2_000;
const probeCacheMs = 15_000;

export type ShellSandboxBackend = "bubblewrap" | "seatbelt" | "wsl2-bubblewrap";
export type ShellSandboxAvailability = Readonly<{
  available: boolean;
  backend: ShellSandboxBackend | null;
  networkIsolation: boolean;
  reason?: string;
}>;
export type ShellSandboxPolicy = Readonly<{
  workspaceDir: string;
  workspaceAccess: WorkspaceAccess;
  networkEnabled: boolean;
  /** Host-owned roots; never supplied by the model. */
  protectedPaths?: readonly string[];
}>;
export type SandboxedShellProcess = Readonly<{
  child: ChildProcess;
  backend: ShellSandboxBackend;
  terminate(): void;
}>;

export class ShellSandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "ShellSandboxUnavailableError";
  }
}

let cachedAvailability: { expires: number; value: ShellSandboxAvailability } | undefined;

/** A functional probe, not merely a check that a binary exists. */
export function shellSandboxAvailability(): ShellSandboxAvailability {
  if (cachedAvailability && cachedAvailability.expires > Date.now()) return cachedAvailability.value;
  let value: ShellSandboxAvailability;
  if (process.platform === "linux") {
    const available = executable(bubblewrapPath) && probe(bubblewrapPath, linuxProbeArguments(true));
    // Offline enforcement is an optional capability, not a prerequisite for
    // the user's chosen online Shell policy.
    const networkIsolation = available && probe(bubblewrapPath, linuxProbeArguments(false));
    value = { available, backend: "bubblewrap", networkIsolation,
      ...(!available ? { reason: "Bubblewrap could not enforce a sandbox; install bubblewrap and check user-namespace permissions." } : {}) };
  } else if (process.platform === "darwin") {
    const available = executable(seatbeltPath) && probeSeatbelt();
    value = { available, backend: "seatbelt", networkIsolation: false,
      ...(!available ? { reason: "macOS Seatbelt is unavailable; shell commands will not run unconfined." } : {}) };
  } else if (process.platform === "win32") {
    let available = false;
    let networkIsolation = false;
    try {
      const wsl = windowsWslExecutable();
      const env = windowsHostEnvironment();
      const version = spawnSync(wsl, ["--exec", "/usr/bin/uname", "-r"], {
        encoding: "utf8", timeout: probeTimeoutMs, windowsHide: true, env,
      });
      const prefix = ["--exec", "/usr/bin/setsid", "/usr/bin/bash", "--noprofile", "--norc", "-c",
        'test -x /usr/bin/wslpath && exec "$@"', "yourchar-probe", bubblewrapPath];
      available = version.status === 0 && /(?:WSL2|microsoft-standard)/i.test(version.stdout ?? "") &&
        probe(wsl, [...prefix, ...linuxProbeArguments(true)], env);
      networkIsolation = available && probe(wsl, [...prefix, ...linuxProbeArguments(false)], env);
    } catch { /* An unavailable Windows runtime must disable Shell, not break settings. */ }
    value = { available, backend: "wsl2-bubblewrap", networkIsolation,
      ...(!available ? { reason: "Start a WSL2 default distribution with /usr/bin/bwrap, bash and setsid installed. Native Windows write-only confinement cannot protect private files." } : {}) };
  } else {
    value = { available: false, backend: null, networkIsolation: false,
      reason: "No sandbox enforcing the required file-read and file-write boundaries is available." };
  }
  cachedAvailability = { expires: Date.now() + probeCacheMs, value: Object.freeze(value) };
  return cachedAvailability.value;
}

/** Linux runtime visibility stays deliberately narrower than DSH's host-root bind. */
export function bubblewrapArguments(policy: ShellSandboxPolicy, command: string): string[] {
  const workspace = realpathSync(policy.workspaceDir);
  assertRuntimeDisjoint([workspace, ...(policy.protectedPaths ?? []).map(canonicalCandidate)],
    ["/usr", ...(policy.networkEnabled ? ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/ssl/certs"] : [])]
      .filter(existsSync).map(path => realpathSync(path)));
  return linuxArguments({ ...policy, workspaceDir: workspace }, command);
}

function linuxArguments(policy: ShellSandboxPolicy, command: string): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (policy.networkEnabled) args.push("--share-net");
  args.push("--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home");
  if (policy.workspaceAccess === "off") args.push("--dir", "/workspace");
  else args.push(policy.workspaceAccess === "read_write" ? "--bind" : "--ro-bind", policy.workspaceDir, "/workspace");
  if (policy.networkEnabled) {
    for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/ssl/certs"]) {
      args.push("--ro-bind-try", path, path);
    }
  }
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8", "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", command);
  return args;
}

function linuxProbeArguments(networkEnabled: boolean): string[] {
  return linuxArguments({ workspaceDir: "/workspace", workspaceAccess: "off", networkEnabled }, "true");
}

export const macosRuntimeReadPaths = Object.freeze([
  "/System", "/usr", "/bin", "/sbin", "/opt/homebrew",
  "/Library/Apple", "/Library/Developer", "/private/etc",
  "/private/var/db/dyld", "/private/var/db/timezone", "/dev",
]);

/** Pure profile builder; resolved paths are supplied by the trusted launcher. */
export function seatbeltProfile(policy: ShellSandboxPolicy, scratchDir: string, runtimePaths = macosRuntimeReadPaths): string {
  if (!policy.networkEnabled) {
    throw new ShellSandboxUnavailableError("This native sandbox uses the host network. Enable shell networking or leave Shell disabled.");
  }
  assertRuntimeDisjoint([...(policy.protectedPaths ?? []), policy.workspaceDir, scratchDir], runtimePaths);
  const reads = [...runtimePaths, scratchDir,
    ...(policy.workspaceAccess === "off" ? [] : [policy.workspaceDir])];
  const writes = [scratchDir, ...(policy.workspaceAccess === "read_write" ? [policy.workspaceDir] : [])];
  // Permit path traversal/stat for approved roots without exposing ancestor contents.
  const metadata = new Set<string>();
  for (const path of reads) {
    let ancestor = dirname(path);
    while (true) {
      metadata.add(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return [
    "(version 1)", "(deny default)",
    "(allow process-exec)", "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))", "(allow mach-priv-task-port (target same-sandbox))",
    "(allow sysctl-read)", "(allow network*)", "(allow ipc-posix-shm)", "(allow ipc-posix-sem)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.logd") (global-name "com.apple.trustd.agent"))',
    `(allow file-read-metadata ${[...metadata].map(path => `(literal ${sbplString(path)})`).join(" ")})`,
    `(allow file-read* ${reads.map(path => `(subpath ${sbplString(path)})`).join(" ")})`,
    `(allow file-write* ${writes.map(path => `(subpath ${sbplString(path)})`).join(" ")} (literal \"/dev/null\"))`,
  ].join("\n");
}

/** stdin is a lifetime lease: EOF kills the Linux group even if wsl.exe exits. */
export const wslSupervisorScript = [
  "set -u", "exec 3<&0", '/usr/bin/setsid "$@" </dev/null &', "payload=$!",
  "cleanup() { kill -KILL -- -\"$payload\" 2>/dev/null || true; }",
  "trap cleanup EXIT HUP INT TERM",
  '( IFS= read -r lease <&3; cleanup ) &', "watcher=$!", "result=0",
  'wait "$payload" || result=$?', 'kill "$watcher" 2>/dev/null || true', 'wait "$watcher" 2>/dev/null || true',
  'exit "$result"',
].join("\n");

export function spawnSandboxedShell(policy: ShellSandboxPolicy, command: string): SandboxedShellProcess {
  const availability = shellSandboxAvailability();
  if (!availability.available || !availability.backend) {
    throw new ShellSandboxUnavailableError(availability.reason ?? "Sandbox is unavailable");
  }
  if (!policy.networkEnabled && !availability.networkIsolation) {
    throw new ShellSandboxUnavailableError("This sandbox cannot enforce offline execution. Enable shell networking or leave Shell disabled.");
  }
  const workspace = realpathSync(policy.workspaceDir);
  assertWorkspaceNotPrivateRoot(workspace, policy.protectedPaths ?? []);
  let scratch: string | undefined;
  let commandPath: string;
  let args: string[];
  let cwd: string | undefined;
  let env: NodeJS.ProcessEnv;
  const leasedStdin = availability.backend === "wsl2-bubblewrap";
  if (availability.backend === "bubblewrap") {
    commandPath = bubblewrapPath;
    args = bubblewrapArguments(policy, command);
    env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  } else if (availability.backend === "seatbelt") {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-shell-")));
    try {
      mkdirSync(join(scratch, "home"), { mode: 0o700 });
      mkdirSync(join(scratch, "workspace"), { mode: 0o700 });
      const profile = seatbeltProfile({ ...policy, workspaceDir: workspace,
        protectedPaths: policy.protectedPaths?.map(canonicalCandidate) }, scratch,
        macosRuntimeReadPaths.filter(existsSync).map(path => realpathSync(path)));
      commandPath = seatbeltPath;
      args = ["-p", profile, "/bin/bash", "--noprofile", "--norc", "-c", command];
      cwd = policy.workspaceAccess === "off" ? join(scratch, "workspace") : workspace;
      env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", LANG: "en_US.UTF-8",
        HOME: join(scratch, "home"), TMPDIR: scratch };
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  } else {
    commandPath = windowsWslExecutable();
    env = windowsHostEnvironment();
    const translated = spawnSync(commandPath, ["--exec", "/usr/bin/wslpath", "-a", "-u", workspace], {
      encoding: "utf8", timeout: probeTimeoutMs, windowsHide: true, env,
    });
    const linuxWorkspace = translated.stdout?.trim();
    if (translated.status !== 0 || !linuxWorkspace?.startsWith("/") || /[\r\n\0]/.test(linuxWorkspace)) {
      throw new ShellSandboxUnavailableError("WSL2 could not resolve the selected Workspace.");
    }
    if (linuxWorkspace === "/usr" || linuxWorkspace.startsWith("/usr/")) {
      throw new ShellSandboxUnavailableError("Workspace overlaps a WSL runtime directory.");
    }
    args = ["--exec", "/usr/bin/bash", "--noprofile", "--norc", "-c", wslSupervisorScript, "yourchar-wsl-supervisor",
      bubblewrapPath, ...linuxArguments({ ...policy, workspaceDir: linuxWorkspace }, command)];
  }
  let child: ChildProcess;
  try {
    child = spawn(commandPath, args, { cwd, env, detached: process.platform !== "win32",
      windowsHide: true, stdio: [leasedStdin ? "pipe" : "ignore", "pipe", "pipe"] });
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  let forceStop: NodeJS.Timeout | undefined;
  const stopGroup = () => terminateProcessGroup(child);
  const terminate = () => {
    if (disposed) return;
    if (leasedStdin && child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
      forceStop ??= setTimeout(stopGroup, 1_000);
      forceStop.unref();
    } else stopGroup();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (forceStop) clearTimeout(forceStop);
    stopGroup();
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Private scratch remains isolated. */ }
    }
  };
  child.stdin?.on("error", () => {}); // EPIPE after a completed WSL payload.
  child.once("error", dispose);
  child.once("close", dispose);
  return { child, backend: availability.backend, terminate };
}

function probeSeatbelt(): boolean {
  let scratch: string | undefined;
  try {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-sandbox-probe-")));
    const profile = seatbeltProfile({ workspaceDir: scratch, workspaceAccess: "off", networkEnabled: true }, scratch,
      macosRuntimeReadPaths.filter(existsSync).map(path => realpathSync(path)));
    return probe(seatbeltPath, ["-p", profile, "/bin/bash", "--noprofile", "--norc", "-c", "printf probe > probe.txt && test -s probe.txt"],
      { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8" }, scratch);
  } catch { return false; }
  finally {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Owned private temporary directory only. */ } }
  }
}
function probe(command: string, args: string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, cwd?: string): boolean {
  const result = spawnSync(command, args, { env, cwd, stdio: "ignore", timeout: probeTimeoutMs, windowsHide: true });
  return !result.error && result.status === 0;
}
function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
function sbplString(path: string): string {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new ShellSandboxUnavailableError("Sandbox paths must be absolute and contain no control characters.");
  return JSON.stringify(path);
}
function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
function assertRuntimeDisjoint(paths: readonly string[], runtimes: readonly string[]): void {
  for (const path of paths) {
    for (const runtime of runtimes) {
      if (within(path, runtime) || within(runtime, path)) {
        throw new ShellSandboxUnavailableError("Private state or Workspace overlaps a sandbox runtime directory.");
      }
    }
  }
}
function canonicalCandidate(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}
function assertWorkspaceNotPrivateRoot(workspace: string, protectedPaths: readonly string[]): void {
  for (const path of protectedPaths) {
    const root = canonicalCandidate(path);
    if (within(root, workspace)) throw new ShellSandboxUnavailableError("Workspace cannot expose a protected state root.");
  }
}
function windowsWslExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new ShellSandboxUnavailableError("Windows SystemRoot is unavailable.");
  return join(systemRoot, "System32", "wsl.exe");
}
function windowsHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
function terminateProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Already exited or not a group leader. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* Reaped by its owner. */ }
}
