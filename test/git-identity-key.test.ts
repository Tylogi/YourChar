import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateManagedGitIdentityKey,
  GitIdentityKeyError,
  gitIdentityPublicKey,
  resolveGitIdentityPrivateKey,
} from "../src/git/identity-key.js";
import type { GitIdentity } from "../src/git/types.js";

test("managed Git identity keys are generated atomically outside Workspace", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-key-"));
  const identity = fixtureIdentity();
  try {
    const generated = await generateManagedGitIdentityKey({ stateDir, identity });
    const managed: GitIdentity = {
      ...identity,
      credential: { kind: "managed-ed25519", keyRef: generated.keyRef },
      fingerprint: generated.fingerprint,
    };
    const keyPath = resolveGitIdentityPrivateKey(stateDir, managed);
    assert.equal(lstatSync(keyPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(stateDir, "git", "credentials", identity.storageKey)).mode & 0o777, 0o700);
    assert.match(readFileSync(keyPath, "utf8"), /OPENSSH PRIVATE KEY/u);
    assert.equal(gitIdentityPublicKey(stateDir, managed), generated.publicKey);
    assert.match(generated.publicKey, /^ssh-ed25519 /u);
    assert.match(generated.fingerprint, /^SHA256:/u);
    await assert.rejects(
      generateManagedGitIdentityKey({ stateDir, identity: managed }),
      (error: unknown) => error instanceof GitIdentityKeyError,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("managed key generation accepts the registry's maximum-length storage key", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-key-long-storage-"));
  const identity: GitIdentity = {
    ...fixtureIdentity(),
    storageKey: `a${"b".repeat(95)}`,
  };
  try {
    const generated = await generateManagedGitIdentityKey({ stateDir, identity });
    assert.equal(generated.keyRef, `credentials/${identity.storageKey}/id_ed25519`);
    const managed: GitIdentity = {
      ...identity,
      credential: { kind: "managed-ed25519", keyRef: generated.keyRef },
      fingerprint: generated.fingerprint,
    };
    assert.equal(lstatSync(resolveGitIdentityPrivateKey(stateDir, managed)).mode & 0o777, 0o600);
    assert.equal(gitIdentityPublicKey(stateDir, managed), generated.publicKey);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Git identity private keys reject permissive files and managed symlinks", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-key-unsafe-"));
  const external = join(stateDir, "external");
  writeFileSync(external, "not-a-real-key\n", { mode: 0o644 });
  const identity: GitIdentity = {
    ...fixtureIdentity(),
    credential: { kind: "external-file", privateKeyPath: external },
  };
  try {
    assert.throws(
      () => resolveGitIdentityPrivateKey(stateDir, identity),
      (error: unknown) => error instanceof GitIdentityKeyError && /group or other/u.test(error.message),
    );
    const credentialDir = join(stateDir, "git", "credentials", identity.storageKey);
    const real = join(stateDir, "real-key");
    writeFileSync(real, "private\n", { mode: 0o600 });
    mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    symlinkSync(real, join(credentialDir, "id_ed25519"));
    const managed: GitIdentity = {
      ...identity,
      credential: { kind: "managed-ed25519", keyRef: `credentials/${identity.storageKey}/id_ed25519` },
    };
    assert.throws(
      () => resolveGitIdentityPrivateKey(stateDir, managed),
      (error: unknown) => error instanceof GitIdentityKeyError && /non-symlink/u.test(error.message),
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function fixtureIdentity(): GitIdentity {
  return {
    id: "identity_test-managed",
    name: "Forgejo",
    storageKey: "forgejo-test",
    credential: { kind: "unconfigured" },
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}
