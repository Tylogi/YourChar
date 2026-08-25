import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import {
  GitRegistryError,
  GitRegistryService,
  legacyGitBindingId,
  legacyGitIdentityId,
  legacyGitProjectId,
  legacyGitRepositoryId,
} from "../src/git/index.js";

test("Git registry atomically and idempotently migrates the legacy fixed repository without moving its checkout", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-migrate-"));
  const legacyPath = join(stateDir, "git-repository.json");
  const legacy = `${JSON.stringify({
    version: "yourchar-git-v1",
    repositoryName: "Review",
    remoteUrl: "ssh://git@example.test/owner/Review.git",
    branch: "main",
    privateKeyPath: "/run/yourchar/keys/review",
    proxyMode: "hclient",
    proxyPort: 61090,
    updatedAt: "2026-08-24T10:00:00.000Z",
  }, null, 2)}\n`;
  writeFileSync(legacyPath, legacy, { mode: 0o600 });
  const clock = new VirtualClock("2026-08-25T08:00:00.000Z");
  try {
    const service = new GitRegistryService({ stateDir, clock });
    const registry = service.snapshot();
    assert.equal(registry.version, "yourchar-git-v2");
    assert.equal(registry.revision, 1);
    assert.deepEqual(registry.defaults, {
      identityId: legacyGitIdentityId,
      projectId: legacyGitProjectId,
      repositoryId: legacyGitRepositoryId,
    });
    assert.equal(registry.identities[0]?.id, legacyGitIdentityId);
    assert.deepEqual(registry.identities[0]?.credential, {
      kind: "external-file",
      privateKeyPath: "/run/yourchar/keys/review",
    });
    assert.equal(registry.projects[0]?.id, legacyGitProjectId);
    assert.equal(registry.repositories[0]?.id, legacyGitRepositoryId);
    assert.equal(registry.repositories[0]?.checkoutRelativePath, "repos/Review");
    assert.equal(registry.repositories[0]?.proxyMode, "hclient");
    assert.equal(registry.projectRepositories[0]?.id, legacyGitBindingId);
    assert.equal(registry.migration?.sourceSha256, createHash("sha256").update(legacy).digest("hex"));
    assert.equal(service.getLegacyConfig().configured, true);
    assert.equal(readFileSync(legacyPath, "utf8"), legacy, "migration must preserve the legacy source byte-for-byte");

    const registryPath = join(stateDir, "git", "registry.json");
    assert.equal(lstatSync(registryPath).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(stateDir, "git")).some((entry) => entry.includes(".tmp-")), false);

    clock.advance(60_000);
    const reloaded = new GitRegistryService({ stateDir, clock }).snapshot();
    assert.deepEqual(reloaded, registry, "an existing v2 registry must win over and not repeat legacy migration");
    assert.equal(readFileSync(legacyPath, "utf8"), legacy);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Git registry supports multiple projects and repositories while names do not control stable paths", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-crud-"));
  const clock = new VirtualClock("2026-08-25T09:00:00.000Z");
  try {
    const service = new GitRegistryService({ stateDir, clock });
    const identity = service.createIdentity({
      name: "Forgejo deploy key",
      credential: { kind: "external-file", privateKeyPath: "/run/yourchar/keys/forgejo" },
    });
    const reviewProject = service.createProject({ name: "Paper Review", description: "Review papers and source files." });
    const reviewRepository = service.createRepository({
      name: "Review",
      remoteUrl: "ssh://git@forgejo.example.test/owner/Review.git",
      identityId: identity.id,
      proxyMode: "hclient",
    });
    const reviewBinding = service.createBinding({
      projectId: reviewProject.id,
      repositoryId: reviewRepository.id,
      name: "Paper source",
      role: "primary",
      isDefault: true,
    });
    service.setDefaults({
      identityId: identity.id,
      projectId: reviewProject.id,
      repositoryId: reviewRepository.id,
    });

    const yourCharProject = service.createProject({ name: "YourChar" });
    const sharedBinding = service.createBinding({
      projectId: yourCharProject.id,
      repositoryId: reviewRepository.id,
      name: "Shared review fixture",
      role: "dependency",
    });
    assert.notEqual(sharedBinding.id, reviewBinding.id);

    const originalIdentityStorageKey = identity.storageKey;
    const originalProjectStorageKey = reviewProject.storageKey;
    const originalRepositoryStorageKey = reviewRepository.storageKey;
    const originalCheckout = reviewRepository.checkoutRelativePath;
    clock.advance(1_000);
    const renamedIdentity = service.updateIdentity(identity.id, { name: "Primary Forgejo identity" });
    const renamedProject = service.updateProject(reviewProject.id, { name: "Academic Review" });
    const renamedRepository = service.updateRepository(reviewRepository.id, { name: "Review Sources" });
    assert.equal(renamedIdentity.storageKey, originalIdentityStorageKey);
    assert.equal(renamedProject.storageKey, originalProjectStorageKey);
    assert.equal(renamedRepository.storageKey, originalRepositoryStorageKey);
    assert.equal(renamedRepository.checkoutRelativePath, originalCheckout);
    assert.match(identity.id, /^identity_/u);
    assert.match(reviewProject.id, /^project_/u);
    assert.match(reviewRepository.id, /^repository_/u);

    const resolved = service.resolveRepository(reviewRepository.id);
    assert.equal(resolved.identity.id, identity.id);
    assert.deepEqual(new Set(resolved.projects.map((entry) => entry.id)), new Set([reviewProject.id, yourCharProject.id]));
    assert.equal(service.getDefaults().binding?.id, reviewBinding.id);
    assert.throws(
      () => service.deleteIdentity(identity.id),
      (error: unknown) => error instanceof GitRegistryError && error.code === "GIT_REGISTRY_CONFLICT",
    );

    const revisionBeforeConflict = service.snapshot().revision;
    assert.throws(
      () => service.createBinding({ projectId: reviewProject.id, repositoryId: reviewRepository.id }),
      (error: unknown) => error instanceof GitRegistryError && error.code === "GIT_REGISTRY_CONFLICT",
    );
    assert.equal(service.snapshot().revision, revisionBeforeConflict);
    assert.equal(lstatSync(join(stateDir, "git", "registry.json")).mode & 0o777, 0o600);

    const managedIdentity = service.createIdentity({ name: "Managed deploy key" });
    service.setIdentityCredential(
      managedIdentity.id,
      { kind: "managed-ed25519", keyRef: `credentials/${managedIdentity.storageKey}/id_ed25519` },
      "SHA256:test-host-derived-fingerprint",
    );
    const managedRepository = service.createRepository({
      name: "Managed Repo",
      remoteUrl: "ssh://git@example.test/owner/managed.git",
      identityId: managedIdentity.id,
    });
    const managedProject = service.createProject({ name: "Managed Project" });
    service.createBinding({ projectId: managedProject.id, repositoryId: managedRepository.id, isDefault: true });
    service.setDefaults({ projectId: managedProject.id, repositoryId: managedRepository.id });
    const managedLegacyView = service.getLegacyConfig();
    assert.equal(managedLegacyView.privateKeyPath, "");
    assert.equal(managedLegacyView.configured, true, "managed credentials are configured without exposing a host path");
    assert.equal(service.resolveRepository(managedRepository.id).identity.fingerprint, "SHA256:test-host-derived-fingerprint");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("legacy facade initializes an empty registry and patches only editable metadata", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-facade-"));
  try {
    const service = new GitRegistryService({ stateDir });
    const config = service.patchLegacyConfig({
      repositoryName: "Review",
      remoteUrl: "ssh://git@example.test/owner/Review.git",
      branch: "develop",
      privateKeyPath: "/run/yourchar/keys/review",
      proxyMode: "direct",
      proxyPort: 22,
    });
    assert.equal(config.configured, true);
    assert.equal(config.branch, "develop");
    const repository = service.getDefaults().repository;
    assert.ok(repository);
    const stablePath = repository.checkoutRelativePath;
    service.patchLegacyConfig({ repositoryName: "Renamed Review" });
    assert.equal(service.getDefaults().repository?.checkoutRelativePath, stablePath);
    assert.equal(service.getLegacyConfig().repositoryName, "Renamed Review");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Git registry rejects unsafe legacy sources, symlinks, and tampered v2 paths", () => {
  const invalidLegacyDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-invalid-legacy-"));
  try {
    const legacyPath = join(invalidLegacyDir, "git-repository.json");
    writeFileSync(legacyPath, JSON.stringify({
      repositoryName: "Review",
      remoteUrl: "file:///tmp/review.git",
      branch: "main",
      privateKeyPath: "",
      proxyMode: "direct",
      proxyPort: 22,
    }), { mode: 0o600 });
    assert.throws(() => new GitRegistryService({ stateDir: invalidLegacyDir }), GitRegistryError);
    assert.equal(existsSync(join(invalidLegacyDir, "git", "registry.json")), false);
  } finally {
    rmSync(invalidLegacyDir, { recursive: true, force: true });
  }

  const symlinkDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-symlink-"));
  try {
    const source = join(symlinkDir, "legacy-source.json");
    writeFileSync(source, "{}", { mode: 0o600 });
    symlinkSync(source, join(symlinkDir, "git-repository.json"));
    assert.throws(() => new GitRegistryService({ stateDir: symlinkDir }), GitRegistryError);
  } finally {
    rmSync(symlinkDir, { recursive: true, force: true });
  }

  const tamperedDir = mkdtempSync(join(tmpdir(), "yourchar-git-registry-tamper-"));
  try {
    const service = new GitRegistryService({ stateDir: tamperedDir });
    const identity = service.createIdentity({ name: "SSH" });
    const repository = service.createRepository({ name: "Repo", identityId: identity.id });
    const raw = service.snapshot();
    const target = raw.repositories.find((entry) => entry.id === repository.id);
    assert.ok(target);
    target.checkoutRelativePath = "repos/../outside";
    const registryPath = join(tamperedDir, "git", "registry.json");
    writeFileSync(registryPath, JSON.stringify(raw), { mode: 0o600 });
    chmodSync(registryPath, 0o600);
    assert.throws(() => new GitRegistryService({ stateDir: tamperedDir }), GitRegistryError);
  } finally {
    rmSync(tamperedDir, { recursive: true, force: true });
  }
});
