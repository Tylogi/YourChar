#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("Developer ID signing requires macOS");
const [bundleArgument, identity, entitlementsArgument] = process.argv.slice(2);
if (!bundleArgument || !identity || !entitlementsArgument || process.argv.length !== 5) {
  throw new Error("Usage: sign-macos-release.mjs APP_BUNDLE SIGNING_IDENTITY RUNTIME_ENTITLEMENTS");
}
const bundle = realpathSync(bundleArgument);
const entitlements = realpathSync(entitlementsArgument);
if (!bundle.endsWith(".app")) throw new Error("Expected an app bundle");
const magicValues = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const sign = (path, executable = false, runtime = false) => {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp",
    ...(executable ? ["--options", "runtime"] : []),
    ...(runtime ? ["--entitlements", entitlements] : []), path], { stdio: "inherit" });
};
let binaries = 0;
function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { walk(path); continue; }
    if (!stat.isFile() || stat.size < 4) continue;
    const fd = openSync(path, "r");
    const header = Buffer.alloc(4);
    try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
    if (!magicValues.has(header.readUInt32BE())) continue;
    const description = execFileSync("/usr/bin/file", ["--brief", path], { encoding: "utf8" });
    if (!description.includes("Mach-O")) continue;
    const executable = description.includes("executable");
    // JIT permissions belong to embedded runtimes, not the native window launcher.
    const runtime = executable && path.startsWith(resolve(bundle, "Contents/Resources") + "/");
    sign(path, executable, runtime);
    binaries++;
  }
}
walk(bundle);
// All nested Mach-O code already carries the same Developer ID. Sign the outer
// resource envelope last; --deep is used only for verification.
sign(bundle, true);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle], { stdio: "inherit" });
console.log(`Signed ${binaries} Mach-O files and the app bundle with Developer ID.`);
