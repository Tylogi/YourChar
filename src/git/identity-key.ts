import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GitIdentity } from "./types.js";

const maximumSshKeygenOutputBytes = 16 * 1024;
const managedKeyName = "id_ed25519";
const sshKeygenExecutable = "/usr/bin/ssh-keygen";

export type ManagedGitIdentityKey = {
  keyRef: string;
  fingerprint: string;
  publicKey: string;
};

export class GitIdentityKeyError extends Error {
  readonly code = "GIT_IDENTITY_KEY_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "GitIdentityKeyError";
  }
}

export async function generateManagedGitIdentityKey(input: {
  stateDir?: string;
  identity: Pick<GitIdentity, "id" | "storageKey" | "credential">;
}): Promise<ManagedGitIdentityKey> {
  if (!input.stateDir) {
    throw new GitIdentityKeyError("Persistent state is required to generate a Git identity key");
  }
  if (input.identity.credential.kind === "managed-ed25519") {
    throw new GitIdentityKeyError("This Git identity already has a managed key; create a new identity to rotate keys safely");
  }

  const gitRoot = resolve(input.stateDir, "git");
  const credentialsRoot = join(gitRoot, "credentials");
  ensureRealDirectory(gitRoot);
  ensureRealDirectory(credentialsRoot);
  const targetDir = managedIdentityDirectory(credentialsRoot, input.identity.storageKey);
  if (pathEntryExists(targetDir)) {
    throw new GitIdentityKeyError("Managed Git identity key target already exists");
  }

  const staging = join(credentialsRoot, `.keygen-${process.pid}-${randomBytes(8).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  const privateKey = join(staging, managedKeyName);
  const publicKeyPath = `${privateKey}.pub`;
  try {
    await runSshKeygen([
      "-q",
      "-t", "ed25519",
      "-N", "",
      "-C", `yourchar:${safeKeyComment(input.identity.id)}`,
      "-f", privateKey,
    ]);
    assertGeneratedPrivateKey(privateKey);
    const publicKey = readPublicKey(publicKeyPath);
    const fingerprint = await readFingerprint(publicKeyPath);
    syncRegularFile(privateKey);
    syncRegularFile(publicKeyPath);
    fsyncDirectory(staging);
    renameSync(staging, targetDir);
    fsyncDirectory(credentialsRoot);
    return {
      keyRef: `credentials/${input.identity.storageKey}/${managedKeyName}`,
      fingerprint,
      publicKey,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof GitIdentityKeyError) throw error;
    throw new GitIdentityKeyError(error instanceof Error ? error.message : String(error));
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new GitIdentityKeyError(`Unable to inspect managed Git key target: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveGitIdentityPrivateKey(stateDir: string | undefined, identity: GitIdentity): string {
  if (identity.credential.kind === "unconfigured") {
    throw new GitIdentityKeyError("The selected Git identity has no private key");
  }
  const path = identity.credential.kind === "external-file"
    ? resolve(identity.credential.privateKeyPath)
    : managedKeyPath(stateDir, managedIdentityKeyRef(identity));
  assertPrivateKey(path);
  return path;
}

export function assertGitExternalPrivateKey(path: string): string {
  const normalized = resolve(path);
  assertPrivateKey(normalized);
  return normalized;
}

export function gitIdentityPublicKey(stateDir: string | undefined, identity: GitIdentity): string | undefined {
  if (identity.credential.kind !== "managed-ed25519") return undefined;
  const privateKey = managedKeyPath(stateDir, managedIdentityKeyRef(identity));
  assertPrivateKey(privateKey);
  return readPublicKey(`${privateKey}.pub`);
}

export function discardManagedGitIdentityKey(input: {
  stateDir?: string;
  identity: Pick<GitIdentity, "storageKey">;
  keyRef: string;
}): void {
  const privateKey = managedKeyPath(input.stateDir, input.keyRef);
  const targetDir = dirname(privateKey);
  const expectedDir = managedIdentityDirectory(
    resolve(input.stateDir!, "git", "credentials"),
    input.identity.storageKey,
  );
  if (targetDir !== expectedDir) {
    throw new GitIdentityKeyError("Managed Git key cleanup target does not match the identity");
  }
  let stats;
  try {
    stats = lstatSync(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new GitIdentityKeyError(`Unable to inspect managed Git key cleanup target: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(targetDir) !== targetDir) {
    throw new GitIdentityKeyError("Managed Git key cleanup target must be a real directory");
  }
  rmSync(targetDir, { recursive: true, force: false });
  fsyncDirectory(dirname(targetDir));
}

function managedKeyPath(stateDir: string | undefined, keyRef: string): string {
  if (!stateDir) throw new GitIdentityKeyError("Persistent state is required for a managed Git identity key");
  if (!/^credentials\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/id_ed25519$/u.test(keyRef)) {
    throw new GitIdentityKeyError("Managed Git identity key reference is invalid");
  }
  const gitRoot = resolve(stateDir, "git");
  const path = resolve(gitRoot, keyRef);
  const nested = relative(gitRoot, path);
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`)) {
    throw new GitIdentityKeyError("Managed Git identity key escapes the Git state directory");
  }
  return path;
}

function managedIdentityDirectory(credentialsRoot: string, storageKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(storageKey)) {
    throw new GitIdentityKeyError("Git identity storage key is invalid");
  }
  const target = resolve(credentialsRoot, storageKey);
  if (dirname(target) !== resolve(credentialsRoot)) {
    throw new GitIdentityKeyError("Git identity key target escapes its managed directory");
  }
  return target;
}

function managedIdentityKeyRef(identity: Pick<GitIdentity, "storageKey" | "credential">): string {
  if (identity.credential.kind !== "managed-ed25519") {
    throw new GitIdentityKeyError("Git identity does not use a managed key");
  }
  const expected = `credentials/${identity.storageKey}/${managedKeyName}`;
  if (identity.credential.keyRef !== expected) {
    throw new GitIdentityKeyError("Managed Git key reference does not belong to this identity");
  }
  return expected;
}

function ensureRealDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GitIdentityKeyError("Git credential directory must be a real directory");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new GitIdentityKeyError("Git credential directory must be owned by the YourChar process user");
  }
  chmodSync(path, 0o700);
}

function assertGeneratedPrivateKey(path: string): void {
  chmodSync(path, 0o600);
  assertPrivateKey(path);
  const bytes = readFileSync(path);
  if (bytes.length < 100 || bytes.length > 32 * 1024 || !bytes.toString("utf8").includes("OPENSSH PRIVATE KEY")) {
    throw new GitIdentityKeyError("ssh-keygen returned an invalid private key");
  }
}

function assertPrivateKey(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new GitIdentityKeyError("Git identity private key does not exist");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GitIdentityKeyError("Git identity private key must be a regular non-symlink file");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new GitIdentityKeyError("Git identity private key must be owned by the YourChar process user");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new GitIdentityKeyError("Git identity private key must not allow group or other access");
  }
  const parent = dirname(path);
  if (realpathSync(path) !== path || realpathSync(parent) !== parent) {
    throw new GitIdentityKeyError("Git identity private key path must not traverse symbolic links");
  }
}

function readPublicKey(path: string): string {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new GitIdentityKeyError("Managed Git identity public key does not exist");
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024) {
    throw new GitIdentityKeyError("Managed Git identity public key is invalid");
  }
  const publicKey = readFileSync(path, "utf8").trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,256})?$/u.test(publicKey)) {
    throw new GitIdentityKeyError("Managed Git identity public key has an invalid format");
  }
  return publicKey;
}

async function readFingerprint(publicKeyPath: string): Promise<string> {
  const result = await runSshKeygen(["-l", "-E", "sha256", "-f", publicKeyPath]);
  const match = /\b(SHA256:[A-Za-z0-9+/]+={0,3})\b/u.exec(result.stdout);
  if (!match) throw new GitIdentityKeyError("Unable to read the generated Git identity fingerprint");
  return match[1];
}

async function runSshKeygen(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(sshKeygenExecutable, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: maximumSshKeygenOutputBytes,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new GitIdentityKeyError(`ssh-keygen failed: ${String(stderr || error.message).trim().slice(0, 500)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

function safeKeyComment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) || "identity";
}

function syncRegularFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
