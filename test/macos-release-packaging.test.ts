import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const buildScriptPath = resolve(root, "scripts/build-macos-release.sh");
const launcherPath = resolve(root, "packaging/macos/YourCharLauncher.swift");
const plistPath = resolve(root, "packaging/macos/Info.plist");

test("macOS release pipeline is portable, self-contained, and safety-scoped", () => {
  execFileSync("bash", ["-n", buildScriptPath]);
  const help = execFileSync("bash", [buildScriptPath, "--help"], { encoding: "utf8" });
  const script = readFileSync(buildScriptPath, "utf8");
  const launcher = readFileSync(launcherPath, "utf8");
  const plist = readFileSync(plistPath, "utf8");
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(help, /Apple Silicon macOS/u);
  assert.equal(packageJson.scripts["package:macos"], "bash scripts/build-macos-release.sh");
  assert.match(packageJson.scripts["test:macos"], /macos-release-packaging\.test\.js/u);
  assert.match(script, /git -C "\$repo_root" archive --format=tar HEAD/u);
  assert.match(script, /SHASUMS256/u);
  assert.match(script, /npm ci/u);
  assert.match(script, /npm run test:macos/u);
  assert.match(script, /MACOS_RUN_FULL_TESTS/u);
  assert.match(script, /npm prune --omit=dev/u);
  assert.match(script, /codesign --verify --deep --strict/u);
  assert.match(script, /build_root="\$\(cd "\$build_root" && pwd -P\)"/u);
  assert.match(script, /mkdir -p "\$smoke_state"/u);
  assert.match(script, /--output "\$smoke_response"/u);
  assert.match(script, /api\/v1\/readiness/u);
  assert.match(script, /api\/v1\/characters/u);
  assert.match(script, /character\?\.name !== "红莉栖"/u);
  assert.match(script, /hdiutil create/u);
  assert.match(script, /SHA256SUMS\.txt/u);
  assert.match(launcher, /127\.0\.0\.1/u);
  assert.match(launcher, /applicationSupportDirectory/u);
  assert.match(launcher, /Logs\/YourChar/u);
  assert.match(launcher, /runtime\/bin\/node/u);
  assert.match(launcher, /WebKit/u);
  assert.match(plist, /ai\.tylogi\.yourchar/u);
  assert.match(plist, /<string>11\.0<\/string>/u);
  assert.doesNotMatch([script, launcher, plist].join("\n"), /\/home\/|\/Users\//u);
});
