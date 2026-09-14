import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { VirtualClock } from "../src/app/clock.js";
import { AgentModuleCatalog } from "../src/modules/catalog.js";
import {
  CharacterAgentSkillPackageService,
  characterAgentSkillPackageLimit,
} from "../src/modules/character-skill-packages.js";
import { AgentPermissionCatalog } from "../src/modules/permissions.js";
import {
  AgentSkillInstallerError,
  type SkillInstallerTransport,
} from "../src/modules/skill-installer.js";
import { AppDatabase } from "../src/storage/database.js";

const sourceUrl = "https://downloads.example.com/private-skill.zip";
const publicAddress = { address: "93.184.216.34", family: 4 as const };

test("schema 48 and the character Skill management permission are durable and conservative", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-schema-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  const clock = new VirtualClock("2026-08-26T10:00:00.000Z");
  try {
    const schema = database.connection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    assert.equal(Number(schema.version), 68);
    const columns = database.connection.prepare(
      "PRAGMA table_info(character_agent_skill_packages)",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(columns.map((entry) => entry.name), [
      "character_id",
      "conversation_space",
      "name",
      "description",
      "enabled",
      "source_requested_url",
      "source_resolved_url",
      "source_final_url",
      "source_package_path",
      "source_requested_ref",
      "source_resolved_commit",
      "archive_sha256",
      "digest",
      "manifest_json",
      "created_at",
      "updated_at",
    ]);

    const workspace = join(root, "workspace");
    const permissions = new AgentPermissionCatalog(database, clock, workspace);
    assert.equal(permissions.get().characterSkillManageEnabled, false);
    assert.equal(
      permissions.contextStatus({ mode: "sms", characterId: "character" })
        .includes("Character Skill creation and private package management are disabled"),
      true,
    );
    permissions.update({ characterSkillManageEnabled: true });
    const restarted = new AgentPermissionCatalog(database, clock, workspace);
    assert.equal(restarted.get().characterSkillManageEnabled, true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("character package install binds stage, owner, space, digest, and durable package bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-package-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "character/a");
  insertCharacter(database, "character-b");
  let service: CharacterAgentSkillPackageService | undefined;
  try {
    service = createService(database, root, fixedArchiveTransport("private-planning"));
    const staged = await service.stage({
      characterId: "character/a",
      conversationSpace: "normal",
      sourceUrl,
    });
    assert.equal(staged.metadata.name, "private-planning");
    assert.equal(staged.source.requestedUrl, sourceUrl);
    assert.equal(staged.source.resolvedArchiveUrl, sourceUrl);
    assert.equal(staged.manifest.some((entry) => entry.path === "SKILL.md"), true);
    assert.equal(service.listStages({
      characterId: "character/a",
      conversationSpace: "normal",
    }).length, 1);
    const stageInventory = service.listStages({
      characterId: "character/a",
      conversationSpace: "normal",
    });
    stageInventory[0].manifest[0].path = "caller-mutation";
    assert.equal(service.getStage({
      characterId: "character/a",
      conversationSpace: "normal",
      stageId: staged.stageId,
    })?.manifest[0].path, "SKILL.md");
    assert.deepEqual(service.listStages({
      characterId: "character/a",
      conversationSpace: "secret",
    }), []);
    assert.equal(service.getStage({
      characterId: "character-b",
      conversationSpace: "normal",
      stageId: staged.stageId,
    }), undefined);
    assert.throws(() => service!.confirm({
      characterId: "character-b",
      conversationSpace: "normal",
      stageId: staged.stageId,
      digest: staged.digest,
      enabled: true,
    }), hasCode("STAGE_NOT_FOUND"));
    assert.throws(() => service!.confirm({
      characterId: "character/a",
      conversationSpace: "secret",
      stageId: staged.stageId,
      digest: staged.digest,
      enabled: true,
    }), hasCode("STAGE_NOT_FOUND"));
    assert.throws(() => service!.confirm({
      characterId: "character/a",
      conversationSpace: "normal",
      stageId: staged.stageId,
      digest: "0".repeat(64),
      enabled: true,
    }), hasCode("STAGE_DIGEST_MISMATCH"));

    const installed = service.confirm({
      characterId: "character/a",
      conversationSpace: "normal",
      stageId: staged.stageId,
      digest: staged.digest,
      enabled: true,
    });
    assert.equal(installed.integrity, "verified");
    assert.equal(installed.enabled, true);
    assert.equal(installed.digest, staged.digest);
    assert.deepEqual(installed.manifest, staged.manifest);
    const ownerHash = createHash("sha256").update("character/a").digest("hex");
    const expectedBaseDir = join(
      root,
      "character-agent-skills",
      ownerHash,
      "normal",
      "skills",
      "private-planning",
    );
    const locations = service.effectivePackageLocations({
      characterId: "character/a",
      conversationSpace: "normal",
    });
    assert.deepEqual(locations, [{
      name: "private-planning",
      description: "A private planning workflow.",
      baseDir: expectedBaseDir,
      filePath: join(expectedBaseDir, "SKILL.md"),
      digest: staged.digest,
    }]);
    assert.equal(readFileSync(locations[0].filePath, "utf8"), skillMarkdown("private-planning"));
    assert.equal(service.readPackageSkillMarkdown({
      characterId: "character/a",
      conversationSpace: "normal",
      name: "private-planning",
    }), skillMarkdown("private-planning"));
    assert.equal(service.list({ characterId: "character-b", conversationSpace: "normal" }).length, 0);
    assert.equal(service.list({ characterId: "character/a", conversationSpace: "secret" }).length, 0);

    const catalog = new AgentModuleCatalog(
      database,
      new VirtualClock("2026-08-26T10:00:00.000Z"),
      { cwd: root, stateDir: root },
    );
    catalog.attachCharacterSkillPackages(service);
    assert.deepEqual(
      catalog.enabledSkills("normal", "character/a").map((skill) => skill.name),
      ["private-planning"],
    );
    assert.equal(catalog.enabledSkills("normal", "character-b").length, 0);
    assert.equal(catalog.enabledSkills("secret", "character/a").length, 0);
    assert.match(catalog.skillContext("normal", "character/a"), /private-planning/u);

    service.dispose();
    service = createService(database, root, fixedArchiveTransport("private-planning"));
    assert.equal(
      service.list({ characterId: "character/a", conversationSpace: "normal" })[0].integrity,
      "verified",
    );

    writeFileSync(join(expectedBaseDir, "SKILL.md"), `${skillMarkdown("private-planning")}\ntampered\n`);
    assert.equal(
      service.list({ characterId: "character/a", conversationSpace: "normal" })[0].integrity,
      "changed",
    );
    assert.deepEqual(service.effectivePackageLocations({
      characterId: "character/a",
      conversationSpace: "normal",
    }), []);
    assert.throws(() => service!.setEnabled({
      characterId: "character/a",
      conversationSpace: "normal",
      name: "private-planning",
      enabled: true,
    }), hasCode("SKILL_SOURCE_MISMATCH"));
    assert.throws(() => service!.readPackageSkillMarkdown({
      characterId: "character/a",
      conversationSpace: "normal",
      name: "private-planning",
    }), hasCode("SKILL_SOURCE_MISMATCH"));
    assert.equal(service.setEnabled({
      characterId: "character/a",
      conversationSpace: "normal",
      name: "private-planning",
      enabled: false,
    }).enabled, false);

    service.clearAll();
    assert.equal(existsSync(join(root, "character-agent-skills")), true);
    assert.equal(existsSync(expectedBaseDir), false);
    const count = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM character_agent_skill_packages",
    ).get() as { count: number };
    assert.equal(Number(count.count), 0);
  } finally {
    service?.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("autonomous package install is serialized, idempotent, and rejects same-name source changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-autonomous-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "owner");
  let activeDownloads = 0;
  let maximumActiveDownloads = 0;
  let transportCalls = 0;
  const transport: SkillInstallerTransport = async (request) => {
    transportCalls += 1;
    activeDownloads += 1;
    maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeDownloads -= 1;
    const changed = request.url.pathname.includes("changed");
    return zipResponse(zipSync({
      "wrapper/SKILL.md": strToU8(skillMarkdown("autonomous-planning")),
      "wrapper/references/guide.md": strToU8(
        changed ? "Changed package bytes.\n" : "Original package bytes.\n",
      ),
    }));
  };
  const service = createService(database, root, transport);
  try {
    const installInput = {
      characterId: "owner",
      conversationSpace: "normal" as const,
      sourceUrl: "https://downloads.example.com/autonomous.zip",
    };
    const [first, retry] = await Promise.all([
      service.install(installInput),
      service.install(installInput),
    ]);
    assert.equal(maximumActiveDownloads, 1, "one character/space install is serialized");
    assert.deepEqual(
      [first.alreadyInstalled, retry.alreadyInstalled].sort(),
      [false, true],
    );
    assert.equal(first.package.enabled, true);
    assert.equal(first.package.integrity, "verified");
    assert.equal(first.digest, retry.digest);
    assert.equal(first.sourceHost, "downloads.example.com");
    assert.equal(service.listStages(installInput).length, 0);

    service.setEnabled({ ...installInput, name: "autonomous-planning", enabled: false });
    const enabledRetry = await service.install(installInput);
    assert.equal(enabledRetry.alreadyInstalled, true);
    assert.equal(enabledRetry.package.enabled, true);

    await assert.rejects(service.install({
      ...installInput,
      sourceUrl: "https://downloads.example.com/changed.zip",
    }), hasCode("SKILL_EXISTS"));
    assert.equal(service.listStages(installInput).length, 0);
    assert.equal(transportCalls, 4);
  } finally {
    service.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("autonomous package install cancels a completed stage when its turn aborts before publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-abort-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "owner");
  const controller = new AbortController();
  let nowCalls = 0;
  const service = new CharacterAgentSkillPackageService({
    database,
    stateDir: root,
    transport: fixedArchiveTransport("aborted-install"),
    resolveHostname: async () => [publicAddress],
    now: () => {
      nowCalls += 1;
      if (nowCalls === 1) controller.abort(new Error("turn cancelled"));
      return Date.parse("2026-08-26T10:00:00.000Z");
    },
  });
  try {
    await assert.rejects(service.install({
      characterId: "owner",
      conversationSpace: "normal",
      sourceUrl,
    }, controller.signal), hasCode("REQUEST_ABORTED"));
    assert.deepEqual(service.list({ characterId: "owner", conversationSpace: "normal" }), []);
    assert.deepEqual(service.listStages({ characterId: "owner", conversationSpace: "normal" }), []);
  } finally {
    service.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted uninstall uses disabled digest CAS and recovers verified, changed, and missing packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-uninstall-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "owner");
  const transport: SkillInstallerTransport = async (request) => {
    const name = request.url.pathname.split("/").pop()?.replace(/\.zip$/u, "") || "unnamed";
    return zipResponse(skillArchive(name));
  };
  const service = createService(database, root, transport);
  const scope = { characterId: "owner", conversationSpace: "normal" as const };
  try {
    const changed = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/remove-changed.zip",
    });
    await assert.rejects(service.uninstall({
      ...scope,
      name: changed.package.name,
      digest: changed.digest,
    }), hasCode("PACKAGE_ENABLED"));
    service.setEnabled({ ...scope, name: changed.package.name, enabled: false });
    await assert.rejects(service.uninstall({
      ...scope,
      name: changed.package.name,
      digest: "0".repeat(64),
    }), hasCode("PACKAGE_DIGEST_MISMATCH"));
    const changedLocation = join(
      root,
      "character-agent-skills",
      createHash("sha256").update(scope.characterId).digest("hex"),
      "normal",
      "skills",
      changed.package.name,
    );
    writeFileSync(join(changedLocation, "references", "guide.md"), "tampered\n");
    assert.equal(service.list(scope)[0].integrity, "changed");
    const changedRemoved = await service.uninstall({
      ...scope,
      name: changed.package.name,
      digest: changed.digest,
    });
    assert.equal(changedRemoved.integrityAtRemoval, "changed");
    assert.equal(existsSync(changedLocation), false);

    const missing = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/remove-missing.zip",
    });
    service.setEnabled({ ...scope, name: missing.package.name, enabled: false });
    const missingLocation = service.effectivePackageLocations(scope).find((entry) =>
      entry.name === missing.package.name
    );
    // Disabled packages are intentionally absent from effective locations.
    assert.equal(missingLocation, undefined);
    const missingPath = join(
      root,
      "character-agent-skills",
      createHash("sha256").update(scope.characterId).digest("hex"),
      "normal",
      "skills",
      missing.package.name,
    );
    rmSync(missingPath, { recursive: true, force: false });
    const missingRemoved = await service.uninstall({
      ...scope,
      name: missing.package.name,
      digest: missing.digest,
    });
    assert.equal(missingRemoved.integrityAtRemoval, "missing");

    const rollback = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/remove-rollback.zip",
    });
    service.setEnabled({ ...scope, name: rollback.package.name, enabled: false });
    const rollbackPath = join(
      root,
      "character-agent-skills",
      createHash("sha256").update(scope.characterId).digest("hex"),
      "normal",
      "skills",
      rollback.package.name,
    );
    database.connection.exec(`
      CREATE TRIGGER reject_character_skill_uninstall_test
      BEFORE DELETE ON character_agent_skill_packages
      WHEN OLD.name = 'remove-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'test rejection');
      END;
    `);
    await assert.rejects(service.uninstall({
      ...scope,
      name: rollback.package.name,
      digest: rollback.digest,
    }), hasCode("UNINSTALL_FAILED"));
    database.connection.exec("DROP TRIGGER reject_character_skill_uninstall_test");
    assert.equal(existsSync(rollbackPath), true);
    assert.equal(service.list(scope).some((entry) => entry.name === rollback.package.name), true);

    const unsafe = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/remove-unsafe.zip",
    });
    service.setEnabled({ ...scope, name: unsafe.package.name, enabled: false });
    const unsafePath = join(
      root,
      "character-agent-skills",
      createHash("sha256").update(scope.characterId).digest("hex"),
      "normal",
      "skills",
      unsafe.package.name,
    );
    const external = join(root, "external-package");
    rmSync(unsafePath, { recursive: true, force: false });
    symlinkSync(external, unsafePath);
    await assert.rejects(service.uninstall({
      ...scope,
      name: unsafe.package.name,
      digest: unsafe.digest,
    }), hasCode("UNSAFE_REMOVE"));
    assert.equal(service.list(scope).some((entry) => entry.name === unsafe.package.name), true);
  } finally {
    service.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery restores or finalizes journaled uninstalls and removes install orphans", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-recovery-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "owner");
  const scope = { characterId: "owner", conversationSpace: "normal" as const };
  const ownerHash = createHash("sha256").update(scope.characterId).digest("hex");
  const skillsRoot = join(root, "character-agent-skills", ownerHash, "normal", "skills");
  const uninstallRoot = join(root, "character-agent-skills", ".uninstall-quarantine");
  const transport: SkillInstallerTransport = async (request) => {
    const name = request.url.pathname.split("/").pop()?.replace(/\.zip$/u, "") || "unnamed";
    return zipResponse(skillArchive(name));
  };
  let service = createService(database, root, transport);
  try {
    const restore = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/crash-restore.zip",
    });
    service.setEnabled({ ...scope, name: restore.package.name, enabled: false });
    service.dispose();
    const restoreId = "00000000-0000-4000-8000-000000000001";
    const restoreSource = join(skillsRoot, restore.package.name);
    const restoreTombstone = join(uninstallRoot, `remove-${restoreId}`);
    const restoreJournal = join(uninstallRoot, `uninstall-${restoreId}.json`);
    writeFileSync(restoreJournal, `${JSON.stringify({
      version: 1,
      ...scope,
      name: restore.package.name,
      digest: restore.digest,
      sourceRelative: join(ownerHash, "normal", "skills", restore.package.name),
      tombstoneName: `remove-${restoreId}`,
    })}\n`);
    renameSync(restoreSource, restoreTombstone);

    service = createService(database, root, transport);
    assert.equal(existsSync(restoreSource), true, "a pre-commit crash restores bytes for the durable row");
    assert.equal(existsSync(restoreTombstone), false);
    assert.equal(existsSync(restoreJournal), false);
    assert.equal(service.list(scope).find((entry) => entry.name === restore.package.name)?.integrity, "verified");

    const finalize = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/crash-finalize.zip",
    });
    service.setEnabled({ ...scope, name: finalize.package.name, enabled: false });
    service.dispose();
    const finalizeId = "00000000-0000-4000-8000-000000000002";
    const finalizeSource = join(skillsRoot, finalize.package.name);
    const finalizeTombstone = join(uninstallRoot, `remove-${finalizeId}`);
    const finalizeJournal = join(uninstallRoot, `uninstall-${finalizeId}.json`);
    writeFileSync(finalizeJournal, `${JSON.stringify({
      version: 1,
      ...scope,
      name: finalize.package.name,
      digest: finalize.digest,
      sourceRelative: join(ownerHash, "normal", "skills", finalize.package.name),
      tombstoneName: `remove-${finalizeId}`,
    })}\n`);
    renameSync(finalizeSource, finalizeTombstone);
    database.connection.prepare(`
      DELETE FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ? AND name = ? AND digest = ?
    `).run(scope.characterId, scope.conversationSpace, finalize.package.name, finalize.digest);

    service = createService(database, root, transport);
    assert.equal(existsSync(finalizeSource), false);
    assert.equal(existsSync(finalizeTombstone), false, "a post-commit crash finalizes quarantine cleanup");
    assert.equal(existsSync(finalizeJournal), false);
    assert.equal(service.list(scope).some((entry) => entry.name === finalize.package.name), false);

    const orphan = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/crash-orphan.zip",
    });
    const orphanSource = join(skillsRoot, orphan.package.name);
    service.dispose();
    database.connection.prepare(`
      DELETE FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ? AND name = ? AND digest = ?
    `).run(scope.characterId, scope.conversationSpace, orphan.package.name, orphan.digest);

    service = createService(database, root, transport);
    assert.equal(existsSync(orphanSource), false, "an exact real package directory without a DB row is reconciled");
    const reinstalled = await service.install({
      ...scope,
      sourceUrl: "https://downloads.example.com/crash-orphan.zip",
    });
    assert.equal(reinstalled.alreadyInstalled, false);
    assert.equal(reinstalled.package.integrity, "verified");
  } finally {
    service.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publish rolls back when persistence fails, name policy is enforced, and package limits are per space", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-rollback-"));
  const database = new AppDatabase(join(root, "state.sqlite"));
  insertCharacter(database, "owner");
  let transportCalls = 0;
  const transport: SkillInstallerTransport = async (request) => {
    transportCalls += 1;
    const name = request.url.pathname.split("/").pop()?.replace(/\.zip$/, "") || "unnamed";
    return zipResponse(skillArchive(name));
  };
  const service = createService(database, root, transport, {
    isSkillNameAvailable: (name) => name !== "global-collision",
  });
  try {
    await assert.rejects(service.stage({
      characterId: "owner",
      conversationSpace: "normal",
      sourceUrl: "https://downloads.example.com/global-collision.zip",
    }), hasCode("SKILL_NAME_CONFLICT"));

    const rollbackStage = await service.stage({
      characterId: "owner",
      conversationSpace: "normal",
      sourceUrl: "https://downloads.example.com/rollback-test.zip",
    });
    database.connection.exec(`
      CREATE TRIGGER reject_character_skill_package_test
      BEFORE INSERT ON character_agent_skill_packages
      BEGIN
        SELECT RAISE(ABORT, 'test rejection');
      END;
    `);
    assert.throws(() => service.confirm({
      characterId: "owner",
      conversationSpace: "normal",
      stageId: rollbackStage.stageId,
      digest: rollbackStage.digest,
      enabled: true,
    }));
    database.connection.exec("DROP TRIGGER reject_character_skill_package_test");
    const ownerHash = createHash("sha256").update("owner").digest("hex");
    assert.equal(existsSync(join(
      root,
      "character-agent-skills",
      ownerHash,
      "normal",
      "skills",
      "rollback-test",
    )), false);

    const pending = [];
    for (let index = 1; index <= 4; index += 1) {
      pending.push(await service.stage({
        characterId: "owner",
        conversationSpace: "normal",
        sourceUrl: `https://downloads.example.com/pending-${index}.zip`,
      }));
    }
    const callsBeforeStageLimit = transportCalls;
    await assert.rejects(service.stage({
      characterId: "owner",
      conversationSpace: "normal",
      sourceUrl: "https://downloads.example.com/pending-5.zip",
    }), hasCode("STAGE_LIMIT"));
    assert.equal(transportCalls, callsBeforeStageLimit);
    assert.equal(service.listStages({ characterId: "owner", conversationSpace: "normal" }).length, 4);
    for (const stage of pending) {
      assert.equal(service.cancel({
        characterId: "owner",
        conversationSpace: "normal",
        stageId: stage.stageId,
        digest: stage.digest,
      }), true);
    }

    for (let index = 1; index <= characterAgentSkillPackageLimit; index += 1) {
      const name = `bounded-${String(index).padStart(2, "0")}`;
      const staged = await service.stage({
        characterId: "owner",
        conversationSpace: "normal",
        sourceUrl: `https://downloads.example.com/${name}.zip`,
      });
      service.confirm({
        characterId: "owner",
        conversationSpace: "normal",
        stageId: staged.stageId,
        digest: staged.digest,
        enabled: index === 1,
      });
    }
    assert.equal(service.list({ characterId: "owner", conversationSpace: "normal" }).length, 12);
    const callsBeforeLimit = transportCalls;
    await assert.rejects(service.stage({
      characterId: "owner",
      conversationSpace: "normal",
      sourceUrl: "https://downloads.example.com/bounded-13.zip",
    }), hasCode("PACKAGE_LIMIT"));
    assert.equal(transportCalls, callsBeforeLimit, "limit is checked before another remote download");

    const secretStage = await service.stage({
      characterId: "owner",
      conversationSpace: "secret",
      sourceUrl: "https://downloads.example.com/bounded-01.zip",
    });
    const secretPackage = service.confirm({
      characterId: "owner",
      conversationSpace: "secret",
      stageId: secretStage.stageId,
      digest: secretStage.digest,
      enabled: false,
    });
    assert.equal(secretPackage.conversationSpace, "secret");
    assert.equal(secretPackage.integrity, "verified");
  } finally {
    service.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational backup and restore preserve verified character-private Skill packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-character-skill-backup-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  let database: AppDatabase | undefined;
  let service: CharacterAgentSkillPackageService | undefined;
  try {
    database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
    insertCharacter(database, "backup-owner");
    service = createService(database, stateDir, fixedArchiveTransport("backup-private-skill"));
    const staged = await service.stage({
      characterId: "backup-owner",
      conversationSpace: "secret",
      sourceUrl: "https://downloads.example.com/backup-private-skill.zip",
    });
    service.confirm({
      characterId: "backup-owner",
      conversationSpace: "secret",
      stageId: staged.stageId,
      digest: staged.digest,
      enabled: true,
    });
    service.dispose();
    service = undefined;
    database.close();
    database = undefined;

    const ownerHash = createHash("sha256").update("backup-owner").digest("hex");
    const scopedRoot = join(stateDir, "character-agent-skills", ownerHash, "secret");
    mkdirSync(join(scopedRoot, "skill-installer-quarantine", "stage-orphan"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(scopedRoot, "skill-installer-quarantine", "stage-orphan", "rejected.txt"),
      "REJECTED_STAGE_SENTINEL",
    );
    mkdirSync(join(stateDir, "character-agent-skills", ".uninstall-quarantine", "remove-00000000-0000-4000-8000-000000000000"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(stateDir, "character-agent-skills", ".uninstall-quarantine", "remove-00000000-0000-4000-8000-000000000000", "removed.txt"),
      "REMOVED_PACKAGE_SENTINEL",
    );

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const manifest = JSON.parse(readFileSync(
      join(backupDir, "backup-manifest.json"),
      "utf8",
    )) as {
      containsCharacterAgentSkills?: boolean;
      excludesCharacterAgentSkillTransientState?: boolean;
    };
    assert.equal(manifest.containsCharacterAgentSkills, true);
    assert.equal(manifest.excludesCharacterAgentSkillTransientState, true);
    assert.equal(existsSync(join(
      backupDir,
      "character-agent-skills",
      ownerHash,
      "secret",
      "skill-installer-quarantine",
    )), false);
    assert.equal(existsSync(join(
      backupDir,
      "character-agent-skills",
      ".uninstall-quarantine",
    )), false);
    assert.equal(existsSync(join(
      backupDir,
      "character-agent-skills",
      ownerHash,
      "secret",
      "skills",
      "backup-private-skill",
      "references",
      "skill-installer-quarantine",
      "preserve.txt",
    )), true, "a package resource with the same basename is not transient state");
    database = new AppDatabase(join(restoredDir, "rp-agent.sqlite"));
    service = createService(database, restoredDir, fixedArchiveTransport("unused"));
    const restored = service.list({
      characterId: "backup-owner",
      conversationSpace: "secret",
    });
    assert.equal(restored.length, 1);
    assert.equal(restored[0].name, "backup-private-skill");
    assert.equal(restored[0].enabled, true);
    assert.equal(restored[0].integrity, "verified");
    assert.match(service.readPackageSkillMarkdown({
      characterId: "backup-owner",
      conversationSpace: "secret",
      name: "backup-private-skill",
    }), /# Private Planning/u);
  } finally {
    service?.dispose();
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createService(
  database: AppDatabase,
  root: string,
  transport: SkillInstallerTransport,
  options: { isSkillNameAvailable?: (name: string) => boolean } = {},
): CharacterAgentSkillPackageService {
  return new CharacterAgentSkillPackageService({
    database,
    stateDir: root,
    transport,
    resolveHostname: async () => [publicAddress],
    now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    ...options,
  });
}

function insertCharacter(database: AppDatabase, id: string): void {
  const now = "2026-08-26T10:00:00.000Z";
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, id, now, now);
}

function fixedArchiveTransport(name: string): SkillInstallerTransport {
  return async () => zipResponse(skillArchive(name));
}

function zipResponse(bytes: Uint8Array): { response: Response } {
  return {
    response: new Response(Uint8Array.from(bytes).buffer, {
      headers: { "content-type": "application/zip" },
    }),
  };
}

function skillArchive(name: string): Uint8Array {
  return zipSync({
    "wrapper/SKILL.md": strToU8(skillMarkdown(name)),
    "wrapper/references/guide.md": strToU8("Use bounded, reversible steps.\n"),
    "wrapper/references/skill-installer-quarantine/preserve.txt": strToU8(
      "This is a manifest-bound package resource and must be backed up.\n",
    ),
  });
}

function skillMarkdown(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: A private planning workflow.",
    "---",
    "",
    "# Private Planning",
    "",
    "Read the guide before planning.",
    "",
  ].join("\n");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentSkillInstallerError && error.code === code;
}
