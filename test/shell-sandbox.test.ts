import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bubblewrapArguments, seatbeltProfile, shellSandboxAvailability, ShellSandboxUnavailableError,
  spawnSandboxedShell, wslSupervisorScript, type ShellSandboxPolicy } from "../src/execution/shell-sandbox.js";

const nativePlatform = process.platform === "linux" || process.platform === "darwin";
const availability = shellSandboxAvailability();
const integrationSkip = !nativePlatform || !availability.available ? availability.reason ?? "No native test backend" : false;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("release gate requires a functioning native sandbox", { skip: process.env.YOURCHAR_REQUIRE_NATIVE_SANDBOX !== "1" }, () => {
  assert.ok(nativePlatform, "This release gate runs on Linux or macOS");
  assert.equal(availability.available, true, availability.reason);
});

test("an unsupported provider fails closed without invoking a host shell", () => {
  const f = fixture();
  try {
    const moduleUrl = new URL("../src/execution/shell-sandbox.js", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      Object.defineProperty(process, "platform", { value: "unsupported-test-platform" });
      const { shellSandboxAvailability, spawnSandboxedShell } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(shellSandboxAvailability().available, false);
      assert.throws(() => spawnSandboxedShell(${JSON.stringify(f.policy)}, ${JSON.stringify(`printf escaped > ${quote(join(f.workspaceDir, "host-escape"))}`)}),
        { code: "SANDBOX_UNAVAILABLE" });
    `], { env: { PATH: process.env.PATH }, timeout: 5_000, stdio: "pipe" });
    assert.equal(existsSync(join(f.workspaceDir, "host-escape")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("offline namespace support is optional, but an explicit offline request never becomes online", () => {
  const moduleUrl = new URL("../src/execution/shell-sandbox.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "linux" });
    const probes = [];
    fs.accessSync = () => {};
    childProcess.spawnSync = (_command, args) => {
      probes.push(args);
      return { status: args.includes("--share-net") ? 0 : 1 };
    };
    childProcess.spawn = () => { throw new Error("must not launch an offline-incompatible command"); };
    syncBuiltinESMExports();
    const { shellSandboxAvailability, spawnSandboxedShell } = await import(${JSON.stringify(moduleUrl)});
    const availability = shellSandboxAvailability();
    assert.equal(availability.available, true);
    assert.equal(availability.networkIsolation, false);
    assert.equal(probes.length, 2);
    assert.throws(() => spawnSandboxedShell({ workspaceDir: "/unused", workspaceAccess: "off", networkEnabled: false }, "true"),
      { code: "SANDBOX_UNAVAILABLE" });
  `], { env: { PATH: process.env.PATH }, timeout: 5_000, stdio: "pipe" });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-sandbox-test-")));
  const workspaceDir = join(root, "state", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  return { root, workspaceDir, policy: {
    workspaceDir, workspaceAccess: "read_write", networkEnabled: true, protectedPaths: [join(root, "state")],
  } satisfies ShellSandboxPolicy };
}

async function run(policy: ShellSandboxPolicy, command: string) {
  const running = spawnSandboxedShell(policy, command);
  let stdout = "";
  let stderr = "";
  running.child.stdout?.on("data", chunk => stdout += chunk.toString());
  running.child.stderr?.on("data", chunk => stderr += chunk.toString());
  const timer = setTimeout(running.terminate, 5_000);
  try {
    const [code] = await once(running.child, "close");
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("Seatbelt policy is read-confined, preserves write modes and never claims offline enforcement", () => {
  const policy: ShellSandboxPolicy = { workspaceDir: "/Users/test/state/workspace", workspaceAccess: "read_only",
    networkEnabled: true, protectedPaths: ["/Users/test/state"] };
  const profile = seatbeltProfile(policy, "/private/var/tmp/yourchar-shell-test");
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(allow network\*\)/);
  assert.ok(profile.includes('(allow file-read-data (literal "/"))'));
  assert.ok(!profile.includes('(subpath "/")'), "startup access must not expose the host filesystem");
  const metadataRule = profile.split("\n").find(line => line.startsWith("(allow file-read-metadata"))!;
  for (const alias of ["/etc", "/var", "/tmp"]) {
    assert.ok(metadataRule.includes(`(literal "${alias}")`));
    assert.ok(!profile.includes(`(subpath "${alias}")`), "alias metadata must not grant recursive access");
  }
  assert.match(profile, /\(allow file-read\*.*\/Users\/test\/state\/workspace/);
  const writeRule = profile.split("\n").find(line => line.startsWith("(allow file-write*"))!;
  assert.doesNotMatch(writeRule, /state\/workspace/);
  assert.doesNotMatch(profile, /\(subpath "\/Users\/test\/state"\)/);
  assert.match(profile, /process-info\* \(target same-sandbox\)/);
  assert.throws(() => seatbeltProfile({ ...policy, networkEnabled: false }, "/private/var/tmp/scratch"), ShellSandboxUnavailableError);
  assert.throws(() => seatbeltProfile({ ...policy, protectedPaths: ["/usr/private-state"] }, "/private/var/tmp/scratch"), /overlaps/);
  assert.throws(() => seatbeltProfile({ ...policy, workspaceDir: "/Users/test/invalid\npath" }, "/private/var/tmp/scratch"), /control characters/);
  const off = seatbeltProfile({ ...policy, workspaceAccess: "off" }, "/private/var/tmp/scratch");
  assert.doesNotMatch(off, /subpath "\/Users\/test\/state\/workspace"/);
  const escaped = seatbeltProfile({ ...policy, workspaceDir: '/Users/test/a"b\\c' }, "/private/var/tmp/scratch");
  assert.ok(escaped.includes(JSON.stringify('/Users/test/a"b\\c')));
});

test("Linux profiles retain empty/read-only/read-write scopes and optional legacy offline support", { skip: process.platform !== "linux" }, () => {
  const f = fixture();
  try {
    const online = bubblewrapArguments(f.policy, "printf ok");
    assert.ok(online.includes("--share-net"));
    assert.equal(online.includes("/"), false, "no read-only host-root bind");
    const offline = bubblewrapArguments({ ...f.policy, networkEnabled: false }, "true");
    assert.equal(offline.includes("--share-net"), false);
    assert.equal(offline.includes("/etc/resolv.conf"), false);
    const empty = bubblewrapArguments({ ...f.policy, workspaceAccess: "off" }, "true");
    assert.equal(empty.includes(f.workspaceDir), false);
    assert.throws(() => bubblewrapArguments({ ...f.policy, protectedPaths: ["/usr/private-state"] }, "true"), /overlaps/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native shell works but cannot read private credentials, sibling workspaces, or symlink escapes", { skip: integrationSkip }, async () => {
  const f = fixture();
  try {
    const secret = join(f.root, "state", "model-credentials.json");
    const sibling = join(f.root, "state", "workspace-secret");
    writeFileSync(secret, "fixture-private-key");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "memory.txt"), "fixture-private-memory");
    writeFileSync(join(f.workspaceDir, "allowed.txt"), "workspace-visible");
    symlinkSync(secret, join(f.workspaceDir, "escape"));
    const result = await run(f.policy, [
      "set -e", "cat allowed.txt", "printf written > result.txt",
      `if cat ${quote(secret)} 2>/dev/null; then exit 51; fi`,
      `if cat ${quote(join(sibling, "memory.txt"))} 2>/dev/null; then exit 52; fi`,
      "if cat escape 2>/dev/null; then exit 53; fi", "printf protected",
    ].join("\n"));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "workspace-visibleprotected");
    assert.equal(readFileSync(join(f.workspaceDir, "result.txt"), "utf8"), "written");
    assert.throws(() => spawnSandboxedShell({ ...f.policy, workspaceDir: join(f.root, "state") }, "true"), /protected state root/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native shell seals the host environment and enforces read-only/off even with networking", { skip: integrationSkip }, async () => {
  const f = fixture();
  const previous = process.env.YOURCHAR_TEST_PRIVATE_SECRET;
  process.env.YOURCHAR_TEST_PRIVATE_SECRET = "fixture-only-secret";
  try {
    writeFileSync(join(f.workspaceDir, "visible.txt"), "visible");
    const readonly = await run({ ...f.policy, workspaceAccess: "read_only" },
      'test -z "$YOURCHAR_TEST_PRIVATE_SECRET" && cat visible.txt && if touch forbidden.txt 2>/dev/null; then exit 54; else printf readonly; fi');
    assert.equal(readonly.code, 0, readonly.stderr);
    assert.equal(readonly.stdout, "visiblereadonly");
    assert.equal(existsSync(join(f.workspaceDir, "forbidden.txt")), false);
    const off = await run({ ...f.policy, workspaceAccess: "off" },
      `set -e; test ! -e visible.txt; if cat ${quote(join(f.workspaceDir, "visible.txt"))} >/dev/null 2>&1; then exit 55; fi; ` +
      'printf ephemeral > ephemeral.txt && printf empty-workspace');
    assert.equal(off.code, 0, off.stderr);
    assert.equal(off.stdout, "empty-workspace");
    assert.equal(existsSync(join(f.workspaceDir, "ephemeral.txt")), false);
  } finally {
    if (previous === undefined) delete process.env.YOURCHAR_TEST_PRIVATE_SECRET;
    else process.env.YOURCHAR_TEST_PRIVATE_SECRET = previous;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native shell reaches host networking only when policy permits it", { skip: integrationSkip }, async () => {
  const f = fixture();
  const server = createServer((_request, response) => response.end("fixture-network-ok"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const command = `curl -fsS --max-time 1 http://127.0.0.1:${address.port}`;
  try {
    const online = await run(f.policy, command);
    assert.equal(online.code, 0, online.stderr);
    assert.equal(online.stdout, "fixture-network-ok");
    const hostname = await run(f.policy,
      `test -r /etc/hosts && curl -fsS --max-time 1 http://localhost:${address.port}`);
    assert.equal(hostname.code, 0, hostname.stderr);
    assert.equal(hostname.stdout, "fixture-network-ok");
    if (availability.networkIsolation) {
      const offline = await run({ ...f.policy, networkEnabled: false }, command);
      assert.notEqual(offline.code, 0);
      assert.equal(offline.stdout, "");
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native shell interruption stops the command process group", { skip: integrationSkip }, async () => {
  const f = fixture();
  const running = spawnSandboxedShell(f.policy, "while :; do printf x >> ticks; sleep 0.02; done & wait");
  const closed = once(running.child, "close");
  const timeout = setTimeout(running.terminate, 5_000);
  try {
    for (let i = 0; i < 100 && !existsSync(join(f.workspaceDir, "ticks")); i += 1) await pause(20);
    assert.ok(existsSync(join(f.workspaceDir, "ticks")));
    running.terminate();
    await closed;
    const before = readFileSync(join(f.workspaceDir, "ticks"), "utf8");
    await pause(100);
    assert.equal(readFileSync(join(f.workspaceDir, "ticks"), "utf8"), before);
  } finally { clearTimeout(timeout); running.terminate(); rmSync(f.root, { recursive: true, force: true }); }
});

test("WSL lifetime supervisor ends the payload when its stdin lease closes", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  const child = spawn("/usr/bin/bash", ["--noprofile", "--norc", "-c", wslSupervisorScript, "test-supervisor",
    "/usr/bin/bash", "-c", `while :; do printf x >> ${quote(join(f.workspaceDir, "ticks"))}; sleep 0.02; done`],
  { stdio: ["pipe", "pipe", "pipe"], detached: true });
  const closed = once(child, "close");
  const timeout = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 5_000);
  try {
    for (let i = 0; i < 100 && !existsSync(join(f.workspaceDir, "ticks")); i += 1) await pause(20);
    assert.ok(existsSync(join(f.workspaceDir, "ticks")));
    child.stdin.end();
    await closed;
    const before = readFileSync(join(f.workspaceDir, "ticks"), "utf8");
    await pause(100);
    assert.equal(readFileSync(join(f.workspaceDir, "ticks"), "utf8"), before);
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); rmSync(f.root, { recursive: true, force: true }); }
});
