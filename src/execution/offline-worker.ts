import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryDirectory, type MemoryDirectory } from "./memory-directory.js";
import { bubblewrapPath, shellSandboxAvailability } from "./shell-sandbox.js";

export type WorkerBind = Readonly<{ source: string; target: string }>;
export type OfflineWorkerOptions = Readonly<{
  command: string;
  args: readonly string[];
  binds: readonly WorkerBind[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;
export type OfflineWorker = {
  child: ChildProcessWithoutNullStreams;
  terminate(): void;
  mapPath(path: string): string;
};

const macRuntime = ["/System", "/usr/lib", "/usr/share/locale", "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random"];
let probeCache: { expires: number; available: boolean } | undefined;

export function offlineWorkerAvailable(): boolean {
  if (process.platform === "linux") return shellSandboxAvailability().networkIsolation;
  if (process.platform !== "darwin") return false;
  if (probeCache && probeCache.expires > Date.now()) return probeCache.available;
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", offlineSeatbeltProfile(["/usr/bin/true"], []), "/usr/bin/true"],
    { timeout: 2_000, stdio: "ignore", env: {} });
  const available = !result.error && result.status === 0;
  probeCache = { expires: Date.now() + 15_000, available };
  return available;
}

/** Separate from Shell: no network exceptions and no writable workspace. */
export function offlineSeatbeltProfile(reads: readonly string[], writes: readonly string[]): string {
  const roots = [...macRuntime.filter(existsSync).map(path => realpathSync(path)), ...reads, ...writes];
  const metadata = new Set(["/", "/etc", "/var", "/tmp"]);
  for (const root of roots) {
    let path = dirname(root);
    while (true) { metadata.add(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  const rules = (paths: readonly string[], kind = "subpath") => paths.map(path => `(${kind} ${JSON.stringify(path)})`).join(" ");
  return ["(version 1)", "(deny default)", "(deny network*)",
    '(allow file-read-data (literal "/"))',
    "(allow process-exec)", "(allow process-fork)", "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))", "(allow mach-priv-task-port (target same-sandbox))", "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))',
    `(allow file-read-metadata ${rules([...metadata], "literal")})`,
    `(allow file-read* ${rules(roots)})`,
    `(allow file-write* (literal "/dev/null") ${rules(writes)})`,
  ].join("\n");
}

export function spawnOfflineWorker(options: OfflineWorkerOptions): OfflineWorker {
  if (!offlineWorkerAvailable()) throw new Error("Offline worker sandbox unavailable. Windows users must run the backend inside WSL2; workers never run unconfined.");
  const binds = options.binds.map(bind => ({ source: realpathSync(bind.source), target: bind.target }));
  for (const bind of binds) {
    if (!posix.isAbsolute(bind.target) || posix.normalize(bind.target) !== bind.target || bind.target === "/" || /[\0\r\n]/.test(bind.target)) throw new Error("Invalid worker mount target");
  }
  let scratch: MemoryDirectory | undefined;
  const mapPath = (path: string) => process.platform === "darwin" ? mapWorkerPath(path, binds) : path;
  try {
    let command: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    let cwd: string | undefined;
    if (process.platform === "linux") {
      command = bubblewrapPath;
      args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", "--dir", "/tmp/home"];
      for (const bind of binds) args.push("--ro-bind", bind.source, bind.target);
      args.push("--chdir", options.cwd ?? "/tmp", "--clearenv");
      for (const [key, value] of Object.entries({ PATH: "/usr/bin:/bin", HOME: "/tmp/home", TMPDIR: "/tmp", LANG: "C.UTF-8", ...options.env })) {
        args.push("--setenv", key, value);
      }
      args.push("--", options.command, ...options.args);
      env = {};
    } else {
      scratch = createMemoryDirectory("yourchar-worker-");
      const scratchPath = join(scratch.path, "scratch");
      mkdirSync(scratchPath, { mode: 0o700 });
      mkdirSync(join(scratchPath, "home"), { mode: 0o700 });
      command = "/usr/bin/sandbox-exec";
      args = ["-p", offlineSeatbeltProfile(binds.map(bind => bind.source), [scratchPath]), mapPath(options.command), ...options.args.map(mapPath)];
      cwd = options.cwd ? mapPath(options.cwd) : scratchPath;
      env = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", ...options.env, HOME: join(scratchPath, "home"), TMPDIR: scratchPath };
    }
    const child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd, env });
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    child.once("close", () => {
      // Reap descendants holding scratch open before releasing its RAM volume.
      terminate();
      try { scratch?.dispose(); } catch { /* Exit cleanup / stale-owner recovery retries. */ }
    });
    return { child, terminate, mapPath };
  } catch (error) {
    scratch?.dispose();
    throw error;
  }
}

export function mapWorkerPath(path: string, binds: readonly WorkerBind[]): string {
  for (const bind of [...binds].sort((a, b) => b.target.length - a.target.length)) {
    if (path === bind.target) return bind.source;
    if (path.startsWith(`${bind.target}/`)) {
      const suffix = path.slice(bind.target.length + 1);
      if (posix.normalize(suffix) !== suffix || suffix.startsWith("../")) throw new Error("Worker path escapes its mount");
      return join(bind.source, ...suffix.split("/"));
    }
  }
  return path;
}

/** Only path/URI fields are translated; source text and hover text stay untouched. */
export function workerWorkspaceUri(uri: string, workspace: string, direction: "to-worker" | "from-worker"): string {
  if (process.platform !== "darwin") return uri;
  const source = direction === "to-worker" ? "/workspace" : realpathSync(workspace);
  const destination = direction === "to-worker" ? realpathSync(workspace) : "/workspace";
  const url = new URL(uri);
  if (url.protocol !== "file:" || url.host || url.search || url.hash) throw new Error("Invalid worker workspace URI");
  const suffix = relative(source, fileURLToPath(url));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) throw new Error("Worker URI is outside its workspace");
  return pathToFileURL(join(destination, suffix)).href;
}

export function mapWorkerConfiguration(value: unknown, map: (path: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map(entry => mapWorkerConfiguration(entry, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapWorkerConfiguration(entry, map)]));
  return value;
}
