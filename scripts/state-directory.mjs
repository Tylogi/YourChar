import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveStateDirectory({
  cwd = process.cwd(),
  environment = process.env,
  explicit,
} = {}) {
  if (explicit !== undefined) {
    return resolveConfiguredStatePath(cwd, "state directory argument", explicit);
  }

  if (environment.YOURCHAR_STATE_DIR !== undefined) {
    return resolveConfiguredStatePath(cwd, "YOURCHAR_STATE_DIR", environment.YOURCHAR_STATE_DIR);
  }
  if (environment.RP_AGENT_STATE_DIR !== undefined) {
    return resolveConfiguredStatePath(cwd, "RP_AGENT_STATE_DIR", environment.RP_AGENT_STATE_DIR);
  }

  const defaultPath = resolve(cwd, ".yourchar");
  const legacyPath = resolve(cwd, ".rp-agent");
  const defaultExists = stateDirectoryStatus(defaultPath, "default .yourchar state path");
  const legacyExists = stateDirectoryStatus(legacyPath, "legacy .rp-agent state path");
  if (defaultExists && legacyExists) {
    throw new Error(
      "both .yourchar and legacy .rp-agent exist; set YOURCHAR_STATE_DIR explicitly after resolving the conflict",
    );
  }
  return legacyExists ? legacyPath : defaultPath;
}

function nonEmptyPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredPath(name, value) {
  const path = nonEmptyPath(value);
  if (!path) throw new Error(`${name} is set but empty`);
  return path;
}

function resolveConfiguredStatePath(cwd, name, value) {
  const path = resolve(cwd, requiredPath(name, value));
  stateDirectoryStatus(path, name);
  return path;
}

function stateDirectoryStatus(path, label) {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} must be a real directory: ${path}`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && status.uid !== currentUid) {
      throw new Error(`${label} is not owned by the current user: ${path}`);
    }
    return status;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function runCommand(arguments_) {
  const [command, argument] = arguments_;
  if (command === "resolve") {
    console.log(resolveStateDirectory({ cwd: nonEmptyPath(argument) ?? process.cwd() }));
    return;
  }
  throw new Error("usage: state-directory.mjs resolve [cwd]");
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  runCommand(process.argv.slice(2));
}
