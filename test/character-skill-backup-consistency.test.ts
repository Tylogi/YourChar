import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.js";

type PackageFile = { path: string; bytes: Buffer };

test("character Skill backup copies only row-backed packages and exact transient roots", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-skill-backup-consistency-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const characterId = "backup-character";
  const ownerHash = digest(characterId);
  try {
    const files: PackageFile[] = [
      {
        path: "SKILL.md",
        bytes: Buffer.from("---\nname: backed-up-skill\ndescription: Backup fixture\n---\n\n# Fixture\n"),
      },
      {
        path: "references/.uninstall-quarantine/preserve.txt",
        bytes: Buffer.from("nested uninstall basename is package content\n"),
      },
      {
        path: "references/skill-installer-quarantine/preserve.txt",
        bytes: Buffer.from("nested installer basename is package content\n"),
      },
    ];
    createStateWithPackage({ stateDir, characterId, name: "backed-up-skill", files });

    const packageRoot = join(stateDir, "character-agent-skills");
    writeFixture(
      join(packageRoot, ownerHash, "normal", "skill-installer-quarantine", "stage", "discard.txt"),
      "transient installer stage\n",
    );
    writeFixture(
      join(packageRoot, ".uninstall-quarantine", "remove-fixture", "discard.txt"),
      "transient uninstall tombstone\n",
    );
    writeFixture(
      join(packageRoot, ownerHash, "normal", "skills", "crashed-publish", "SKILL.md"),
      "orphan published package\n",
    );

    runBackup(stateDir, backupDir);

    const backedPackage = join(
      backupDir,
      "character-agent-skills",
      ownerHash,
      "normal",
      "skills",
      "backed-up-skill",
    );
    assert.equal(existsSync(join(backedPackage, "SKILL.md")), true);
    assert.equal(
      existsSync(join(backedPackage, "references", ".uninstall-quarantine", "preserve.txt")),
      true,
      "a transient-looking basename nested inside a published package is preserved",
    );
    assert.equal(
      existsSync(join(backedPackage, "references", "skill-installer-quarantine", "preserve.txt")),
      true,
      "the installer quarantine basename is filtered only at the exact scoped root",
    );
    assert.equal(existsSync(join(
      backupDir,
      "character-agent-skills",
      ownerHash,
      "normal",
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
      "normal",
      "skills",
      "crashed-publish",
    )), false, "a published directory without an exact database row is excluded");

    const manifestPath = join(backupDir, "backup-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.characterAgentSkillPackagesConsistent, true);
    assert.equal(manifest.excludesCharacterAgentSkillTransientState, true);

    // The new flag remains optional so existing schema-v3 backups continue to
    // verify. backup-manifest.json is deliberately outside the payload list.
    delete manifest.characterAgentSkillPackagesConsistent;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    execFileSync(
      process.execPath,
      ["scripts/restore-state.mjs", backupDir, restoredDir, "--verify"],
      { cwd: process.cwd(), stdio: "pipe" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("character Skill backup fails closed when row-backed package bytes are missing or changed", async (context) => {
  for (const variant of ["missing", "changed"] as const) {
    await context.test(variant, () => {
      const root = mkdtempSync(join(tmpdir(), `yourchar-skill-backup-${variant}-`));
      const stateDir = join(root, "state");
      const backupDir = join(root, "backup");
      const characterId = `backup-${variant}`;
      const files: PackageFile[] = [
        {
          path: "SKILL.md",
          bytes: Buffer.from(`---\nname: ${variant}-skill\ndescription: Failure fixture\n---\n\n# Fixture\n`),
        },
      ];
      try {
        const packageDirectory = createStateWithPackage({
          stateDir,
          characterId,
          name: `${variant}-skill`,
          files,
        });
        if (variant === "missing") {
          rmSync(packageDirectory, { recursive: true, force: false });
        } else {
          writeFileSync(join(packageDirectory, "SKILL.md"), "tampered after database commit\n");
        }

        assert.throws(
          () => runBackup(stateDir, backupDir),
          (error: unknown) => {
            const failure = error as { stderr?: Buffer | string; message?: string };
            const details = `${failure.message ?? ""}\n${String(failure.stderr ?? "")}`;
            assert.match(
              details,
              variant === "missing" ? /package bytes are missing/u : /package bytes changed/u,
            );
            return true;
          },
        );
        assert.equal(existsSync(backupDir), false, "a failed check never publishes the destination");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

function createStateWithPackage(input: {
  stateDir: string;
  characterId: string;
  name: string;
  files: PackageFile[];
}): string {
  const database = new AppDatabase(join(input.stateDir, "rp-agent.sqlite"));
  const now = "2026-08-27T00:00:00.000Z";
  try {
    database.connection.prepare(
      "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(input.characterId, input.characterId, now, now);
    const manifest = input.files.map((file) => ({
      path: file.path,
      size: file.bytes.byteLength,
      sha256: digest(file.bytes),
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const packageDigest = digest(JSON.stringify({ version: 1, files: manifest }));
    database.connection.prepare(`
      INSERT INTO character_agent_skill_packages(
        character_id, conversation_space, name, description, enabled,
        source_requested_url, source_resolved_url, source_final_url,
        source_package_path, source_requested_ref, source_resolved_commit,
        archive_sha256, digest, manifest_json, created_at, updated_at
      ) VALUES (?, 'normal', ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      input.characterId,
      input.name,
      "Backup fixture",
      `https://downloads.example.com/${input.name}.zip`,
      `https://downloads.example.com/${input.name}.zip`,
      `https://downloads.example.com/${input.name}.zip`,
      "a".repeat(64),
      packageDigest,
      JSON.stringify(manifest),
      now,
      now,
    );
  } finally {
    database.close();
  }
  const packageDirectory = join(
    input.stateDir,
    "character-agent-skills",
    digest(input.characterId),
    "normal",
    "skills",
    input.name,
  );
  for (const file of input.files) writeFixture(join(packageDirectory, ...file.path.split("/")), file.bytes);
  return packageDirectory;
}

function writeFixture(path: string, contents: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runBackup(stateDir: string, backupDir: string): void {
  execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}
