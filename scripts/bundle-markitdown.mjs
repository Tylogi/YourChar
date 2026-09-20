#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Build on the target OS/architecture: native wheels are not interchangeable.
if (!["linux", "darwin"].includes(process.platform)) throw new Error("Bundle inside Linux/WSL2 or macOS, not on a Windows host.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "services", "markitdown");
const target = join(project, "runtime");
if (existsSync(target)) throw new Error("A bundled runtime already exists; use a fresh build checkout.");
const stage = mkdtempSync(join(project, ".bundle-"));
const uv = process.env.YOURCHAR_BUILD_UV ?? "uv";
const pythonVersion = "3.13.5";
function run(args) {
  execFileSync(uv, args, { cwd: root, stdio: "inherit", env: { ...process.env, UV_LINK_MODE: "copy", MACOSX_DEPLOYMENT_TARGET: "13.0" } });
}
try {
  const installations = join(stage, "python");
  run(["python", "install", "--install-dir", installations, "--no-bin", pythonVersion]);
  const installed = readdirSync(installations).filter(name => name.startsWith(`cpython-${pythonVersion}-`));
  if (installed.length !== 1) throw new Error("Expected exactly one target Python distribution");
  const runtime = join(stage, "runtime");
  cpSync(join(installations, installed[0]), runtime, { recursive: true, verbatimSymlinks: true });
  const requirements = join(stage, "requirements.txt");
  run(["export", "--project", project, "--frozen", "--no-dev", "--no-emit-project", "--format", "requirements-txt", "--output-file", requirements]);
  run(["pip", "install", "--python", join(runtime, "bin", "python3"), "--target", join(runtime, "lib", "python3.13", "site-packages"),
    ...(process.platform === "darwin" ? ["--python-platform", process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"] : []),
    "--require-hashes", "--only-binary", ":all:", "--requirements", requirements]);
  function checkLinks(path) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const resolved = realpathSync(path);
      if (resolved !== runtime && !resolved.startsWith(runtime + sep)) throw new Error("Bundled Python contains an external symlink");
    } else if (stats.isDirectory()) for (const name of readdirSync(path)) checkLinks(join(path, name));
  }
  checkLinks(runtime);
  writeFileSync(join(runtime, "YOURCHAR-RUNTIME.json"), JSON.stringify({ python: pythonVersion, platform: process.platform, arch: process.arch,
    lockSha256: createHash("sha256").update(readFileSync(join(project, "uv.lock"))).digest("hex") }, null, 2) + "\n");
  renameSync(runtime, target);
  // Validate after relocation, without relying on the build venv or its prefix.
  run(["run", "--no-project", "--no-sync", "--python", join(target, "bin", "python3"), "python", "-I", "-c", "from markitdown import MarkItDown; import sqlite3; print('Bundled MarkItDown import OK')"]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
