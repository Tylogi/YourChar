import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertMemoryBacked, createMemoryDirectory, processIdentity } from "../src/execution/memory-directory.js";
import { mapWorkerConfiguration, mapWorkerPath, offlineSeatbeltProfile, offlineWorkerAvailable, spawnOfflineWorker, workerWorkspaceUri } from "../src/execution/offline-worker.js";

test("Windows native worker paths fail closed and the launcher delegates whole-backend execution", () => {
  const module = new URL("../src/execution/offline-worker.js", import.meta.url).href;
  const memory = new URL("../src/execution/memory-directory.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', {value:'win32'});
    const worker=await import(${JSON.stringify(module)});
    const memory=await import(${JSON.stringify(memory)});
    assert.equal(worker.offlineWorkerAvailable(), false);
    assert.throws(()=>worker.spawnOfflineWorker({command:'/usr/bin/true',args:[],binds:[]}), /WSL2/);
    assert.throws(()=>memory.createMemoryDirectory('yourchar-test-'), /WSL2/);
  `]);
  const launcher = readFileSync("scripts/start-wsl.ps1", "utf8");
  assert.match(launcher, /--exec \/bin\/bash \$backendScript/);
  assert.match(launcher, /microsoft-standard/);
  assert.doesNotMatch(launcher, /ExecutionPolicy|sudo|wsl --install|--exec.*python\.exe/);
  execFileSync("bash", ["-n", "scripts/start-wsl-backend.sh"]);
});

test("worker path mapping is bounded and does not alter source text", () => {
  const binds = [{ source: "/reviewed/runtime", target: "/opt/lsp/server" }];
  assert.equal(mapWorkerPath("/opt/lsp/server/lib/main.js", binds), "/reviewed/runtime/lib/main.js");
  assert.equal(mapWorkerPath("/opt/lsp/server-other/a", binds), "/opt/lsp/server-other/a");
  assert.throws(() => mapWorkerPath("/opt/lsp/server/../../secret", binds));
  assert.deepEqual(mapWorkerConfiguration({ tsserver: { path: "/opt/lsp/server/lib/main.js" } }, value => mapWorkerPath(value, binds)), { tsserver: { path: "/reviewed/runtime/lib/main.js" } });
  const profile = offlineSeatbeltProfile(["/reviewed/runtime"], ["/private/scratch"]);
  assert.match(profile, /\(deny network\*\)/);
  assert.doesNotMatch(profile, /\(allow network|subpath "\/Users"|subpath "\/opt\/homebrew"/);
});

test("memory storage rejects disk temp, keeps private permissions and disposes", () => {
  const disk = mkdtempSync(join(tmpdir(), "yourchar-worker-disk-"));
  try { assert.throws(() => assertMemoryBacked(disk)); }
  finally { rmSync(disk, { recursive: true, force: true }); }
  const memory = createMemoryDirectory("yourchar-worker-test-");
  const path = memory.path;
  try {
    assertMemoryBacked(path);
    writeFileSync(join(path, "sentinel"), "RAM_ONLY", { mode: 0o600 });
    assert.equal(readFileSync(join(path, "sentinel"), "utf8"), "RAM_ONLY");
    assert.ok(processIdentity(process.pid));
  } finally { memory.dispose(); }
  memory.dispose();
  assert.equal(existsSync(path), false);
});

test("macOS reclaims only an owned RAM volume after an abrupt owner exit", { skip: process.platform !== "darwin" }, async () => {
  const module = new URL("../src/execution/memory-directory.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const {createMemoryDirectory}=await import(${JSON.stringify(module)});
    const memory=createMemoryDirectory('yourchar-crash-test-');
    console.log(memory.path);
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let buffer = "";
  const path = await new Promise<string>((resolvePath, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("RAM fixture startup timeout")); }, 20_000);
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.includes("\n")) { clearTimeout(timeout); resolvePath(buffer.trim()); }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  child.kill("SIGKILL");
  await closed;
  assert.equal(existsSync(path), true, "abrupt death leaves a recovery candidate");
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    const {createMemoryDirectory}=await import(${JSON.stringify(module)});
    createMemoryDirectory('yourchar-recovery-test-').dispose();
  `], { timeout: 30_000 });
  assert.equal(existsSync(path), false, "fresh process reclaims the verified dead owner's RAM volume");
});

test("native offline worker denies network, host reads, symlink escapes and workspace writes", async () => {
  assert.equal(offlineWorkerAvailable(), true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-offline-boundary-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-offline-private-")));
  const secret = join(outside, "secret");
  writeFileSync(secret, "HOST_PRIVATE_SENTINEL");
  writeFileSync(join(root, "visible"), "WORKSPACE_SENTINEL");
  symlinkSync(secret, join(root, "escape"));
  const server = createServer(socket => socket.end("NETWORK_LEAK"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const workspace = process.platform === "darwin" ? root : "/workspace";
  const script = `
    const fs=require('node:fs'), net=require('node:net');
    const blocked=fn=>{try{fn();return false}catch{return true}};
    const result={visible:fs.readFileSync(${JSON.stringify(join(workspace, "visible"))},'utf8'),
      hostReadBlocked:blocked(()=>fs.readFileSync(${JSON.stringify(secret)})),
      escapeBlocked:blocked(()=>fs.readFileSync(${JSON.stringify(join(workspace, "escape"))})),
      writeBlocked:blocked(()=>fs.writeFileSync(${JSON.stringify(join(workspace, "forbidden"))},'x')),
      environmentClean:!process.env.YOURCHAR_WORKER_SECRET};
    fs.writeFileSync(process.env.TMPDIR+'/scratch','ok');
    const socket=net.connect({host:'127.0.0.1',port:${address.port}});
    socket.on('connect',()=>{result.networkBlocked=false;socket.destroy()});
    socket.on('error',()=>{result.networkBlocked=true});
    socket.setTimeout(1500,()=>{result.networkBlocked=true;socket.destroy()});
    socket.on('close',()=>console.log(JSON.stringify(result)));
  `;
  process.env.YOURCHAR_WORKER_SECRET = "HOST_ENV_SENTINEL";
  const worker = spawnOfflineWorker({ command: "/opt/worker/node", args: ["-e", script], binds: [
    { source: realpathSync(process.execPath), target: "/opt/worker/node" }, { source: root, target: "/workspace" },
  ] });
  delete process.env.YOURCHAR_WORKER_SECRET;
  let stdout = "", stderr = "";
  worker.child.stdout.on("data", chunk => { stdout += chunk; });
  worker.child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => worker.terminate(), 10_000);
  try {
    const [status] = await once(worker.child, "close");
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { visible: "WORKSPACE_SENTINEL", hostReadBlocked: true, escapeBlocked: true, writeBlocked: true, environmentClean: true, networkBlocked: true });
    if (process.platform === "darwin") {
      const uri = workerWorkspaceUri("file:///workspace/a%20b.ts", root, "to-worker");
      assert.equal(workerWorkspaceUri(uri, root, "from-worker"), "file:///workspace/a%20b.ts");
      assert.throws(() => workerWorkspaceUri("file:///etc/passwd", root, "from-worker"));
    }
  } finally {
    clearTimeout(timeout);
    worker.terminate();
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
