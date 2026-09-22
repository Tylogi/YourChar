import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

// The Windows launcher and installer are built by PowerShell scripts. Everything that
// only needs the sources runs everywhere; the checks that need the real interpreter or
// the real packaging tools are skipped where they are unavailable (CI runs them on
// Windows). Each check below fails if the review fix it covers is reverted.
const root = process.cwd();
const launcherScript = resolve(root, "packaging/windows/launcher/build.ps1");
const installerScript = resolve(root, "packaging/windows/installer/build.ps1");
const selectionScript = resolve(root, "packaging/windows/payload-selection.ps1");
const launcherSource = resolve(root, "packaging/windows/launcher/YourChar.cs");
const packagingRoot = resolve(root, "packaging/windows");
const releaseDirectory = resolve(root, "release");

function findPowerShell(): string | null {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh", "powershell.exe"];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" });
      return candidate;
    } catch {
      // not installed, try the next candidate
    }
  }
  return null;
}

function runPowerShell(script: string, cwd?: string): string {
  const shell = findPowerShell();
  assert.ok(shell, "PowerShell is required for this check");
  return execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { cwd, encoding: "utf8" });
}

function defaultPayloadDirectory(scriptPath: string): string {
  const source = readFileSync(scriptPath, "utf8");
  const match = /if \(-not \$PayloadDir\) \{ \$PayloadDir = Join-Path \$scriptDirectory '([^']+)' \}/u.exec(source);
  assert.ok(match, `${scriptPath} does not set a default payload directory`);
  return resolve(dirname(scriptPath), match[1]!.replaceAll("\\", "/"));
}

test("packaging defaults to the repository release/ directory, not packaging/release", () => {
  assert.equal(defaultPayloadDirectory(launcherScript), releaseDirectory);
  assert.equal(defaultPayloadDirectory(installerScript), releaseDirectory);
});

test("packaging takes the payload from the shared version selector, not a name sort", () => {
  for (const scriptPath of [launcherScript, installerScript]) {
    const source = readFileSync(scriptPath, "utf8");
    assert.match(source, /payload-selection\.ps1/u, scriptPath);
    assert.match(source, /Select-LatestPayload/u, scriptPath);
    assert.doesNotMatch(source, /Sort-Object Name/u, scriptPath);
  }
});

test("the installer packaging step always recompiles the launcher", () => {
  const source = readFileSync(installerScript, "utf8");
  assert.match(source, /-SkipPayload -OutDir \$LauncherDir/u);
  assert.doesNotMatch(source, /Test-Path -LiteralPath \$launcher\)/u);
});

test("the repair command line cannot report success for an unfinished repair", () => {
  const source = readFileSync(launcherSource, "utf8");
  // the worker marks completion, however it ends
  assert.match(source, /finally \{ RepairFinished = true; \}/u);
  // the command line waits for that mark instead of a fixed number of seconds
  assert.match(source, /while \(!engine\.RepairFinished && DateTime\.UtcNow < deadline\)/u);
  assert.doesNotMatch(source, /WaitForFinished\(repairEngine\)/u);
  // success is judged from the state the repair reached, and a timeout is a failure
  assert.match(source, /RepairSucceeded \{ get \{ return StageName == "ready"; \} \}/u);
  assert.match(source, /if \(engine\.RepairSucceeded\) return 0;/u);
  assert.match(source, /did not finish within " \+ Cfg\.RepairTimeoutSeconds \+ " seconds[\s\S]{0,120}return 2;/u);
});

test("backend lifecycle operations use the resolved distribution identity", () => {
  const source = readFileSync(launcherSource, "utf8");
  // the distribution must be resolved before a leftover backend is looked for
  assert.match(source, /if \(!EnsureDistro\(\)\) return;\s*\n\s*if \(HandleLeftoverBackend\(\)\) return;/u);
  assert.doesNotMatch(source, /if \(HandleLeftoverBackend\(\)\) return;\s*\n\s*if \(!EnsureDistro\(\)\) return;/u);
  // --status and --stop may only claim a distribution that carries our marker
  assert.match(source, /string\.Equals\(name, Cfg\.DistroName, StringComparison\.OrdinalIgnoreCase\) && Engine\.HasMarker\(name\)/u);
  assert.match(source, /string\.Equals\(name, Cfg\.FallbackDistroName, StringComparison\.OrdinalIgnoreCase\) && Engine\.HasMarker\(name\)/u);
});

test("payload version selection orders 1.0.0 > 0.10.0 > 0.9.0 > 0.2.0", { skip: process.platform === "win32" ? false : "drives the Windows packaging helper; this check runs on Windows" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-payloads-"));
  try {
    assert.doesNotMatch(directory, /['"]/u, "the temporary directory name must be quotable for PowerShell");
    for (const version of ["0.2.0", "0.9.0", "0.10.0", "1.0.0"]) {
      writeFileSync(join(directory, `YourChar-${version}-wsl-amd64.tar.gz`), version);
    }
    // the application-only archive is not a distribution payload and must be ignored
    writeFileSync(join(directory, "YourChar-0.10.0-wsl-amd64-app.tar.gz"), "application only");
    const select = `. '${selectionScript}' ; (Select-LatestPayload -PayloadDir '${directory}').Name`;

    assert.equal(runPowerShell(select).trim(), "YourChar-1.0.0-wsl-amd64.tar.gz");
    rmSync(join(directory, "YourChar-1.0.0-wsl-amd64.tar.gz"));
    rmSync(join(directory, "YourChar-0.2.0-wsl-amd64.tar.gz"));
    // the case the review named: a name sort puts 0.9.0 last
    assert.equal(runPowerShell(select).trim(), "YourChar-0.10.0-wsl-amd64.tar.gz");

    const appOnly = `. '${selectionScript}' ; (Get-YourCharPayloadVersion -Name 'YourChar-0.10.0-wsl-amd64-app.tar.gz') -eq $null`;
    assert.equal(runPowerShell(appOnly).trim(), "True");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated packaging recompiles the launcher and ships the new binary", {
  skip: process.platform !== "win32" || !process.env.YOURCHAR_WINDOWS_PACKAGING
    ? "set YOURCHAR_WINDOWS_PACKAGING=1 on Windows with Inno Setup to run the real packaging build"
    : false,
}, () => {
  const work = mkdtempSync(join(tmpdir(), "yourchar-packaging-"));
  const copy = join(work, "windows");
  const out = join(work, "installer-out");
  const launcherOut = join(work, "launcher-out");
  try {
    cpSync(packagingRoot, copy, { recursive: true });
    const copiedSource = join(copy, "launcher/YourChar.cs");

    runPowerShell(`& '${join(copy, "launcher/build.ps1")}' -SkipPayload -OutDir '${launcherOut}'`);
    const firstBuild = join(launcherOut, "YourChar.exe");
    assert.ok(existsSync(firstBuild), "the first build must produce YourChar.exe");
    assert.ok(existsSync(join(copy, "payload-selection.ps1")), "the shared selector must be part of the packaging tree");

    // Change only the launcher source: the executable itself stays on disk, so a build
    // that reuses an existing exe would ship the older binary.
    writeFileSync(copiedSource, `${readFileSync(copiedSource, "utf8")}\n// packaging freshness marker\n`);
    const markerTime = statSync(copiedSource).mtimeMs;

    const output = runPowerShell(`& '${join(copy, "installer/build.ps1")}' -PayloadDir '${releaseDirectory}' -OutDir '${out}' -LauncherDir '${launcherOut}'`);
    assert.match(output, /compiling the launcher/u);
    assert.ok(statSync(firstBuild).mtimeMs > markerTime, "the launcher must have been compiled again from the changed source");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the documented default packaging command produces the installer", {
  skip: process.platform !== "win32" || !process.env.YOURCHAR_WINDOWS_PACKAGING || !existsSync(releaseDirectory)
    ? "set YOURCHAR_WINDOWS_PACKAGING=1 on Windows with a release/ payload to run the real packaging build"
    : false,
}, () => {
  const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
  const setup = resolve(root, "packaging/windows/installer/out", `YourChar-Setup-${version}.exe`);
  rmSync(setup, { force: true });
  mkdirSync(dirname(setup), { recursive: true });
  // No arguments: this is the command the packaging README documents.
  runPowerShell(`& '${installerScript}'`, root);
  assert.ok(existsSync(setup), `the default build must produce ${setup}`);
});