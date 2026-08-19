import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const projectRoot = process.cwd();
const backupScript = join(projectRoot, "scripts", "backup-state.mjs");
const restoreScript = join(projectRoot, "scripts", "restore-state.mjs");
const stateDirectoryScript = join(projectRoot, "scripts", "state-directory.mjs");
const migrationScript = join(projectRoot, "scripts", "migrate-state-directory.mjs");
const installerScript = join(projectRoot, "scripts", "install-user-service.sh");

test("backup and restore default to .yourchar", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-default-state-"));
  const stateDir = join(root, ".yourchar");
  const environment = defaultStateEnvironment();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "user-profile.md"), "# default state\n", { mode: 0o600 });

    const backupDir = execFileSync(process.execPath, [backupScript], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    }).trim();
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.sourceDirectoryName, ".yourchar");

    rmSync(stateDir, { recursive: true, force: true });
    const restored = execFileSync(process.execPath, [restoreScript, backupDir], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    }).trim();
    assert.equal(restored, stateDir);
    assert.equal(readFileSync(join(stateDir, "user-profile.md"), "utf8"), "# default state\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sole legacy .rp-agent is the compatible default and its backup restores to .yourchar", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-legacy-state-"));
  const legacyStateDir = join(root, ".rp-agent");
  const defaultRestoreDir = join(root, ".yourchar");
  const environment = defaultStateEnvironment();
  try {
    mkdirSync(legacyStateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacyStateDir, "user-profile.md"), "# legacy state\n", { mode: 0o600 });
    const backupDir = execFileSync(process.execPath, [backupScript], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    }).trim();
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.sourceDirectoryName, ".rp-agent");

    rmSync(legacyStateDir, { recursive: true, force: true });
    execFileSync(process.execPath, [restoreScript, backupDir], {
      cwd: root,
      stdio: "pipe",
      env: environment,
    });
    assert.equal(existsSync(join(defaultRestoreDir, "backup-manifest.json")), true);
    assert.equal(
      readFileSync(join(defaultRestoreDir, "user-profile.md"), "utf8"),
      "# legacy state\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-directory resolution honors new then legacy environment and rejects ambiguity", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-state-resolution-"));
  const current = join(root, ".yourchar");
  const legacy = join(root, ".rp-agent");
  const preferred = join(root, "preferred-state");
  const legacyConfigured = join(root, "legacy-configured-state");
  try {
    mkdirSync(current, { mode: 0o700 });
    mkdirSync(legacy, { mode: 0o755 });
    chmodSync(legacy, 0o755);
    assert.equal(
      resolveWithEnvironment(root, {
        YOURCHAR_STATE_DIR: preferred,
        RP_AGENT_STATE_DIR: legacyConfigured,
      }),
      preferred,
    );
    assert.equal(
      resolveWithEnvironment(root, { RP_AGENT_STATE_DIR: legacyConfigured }),
      legacyConfigured,
    );
    const emptyPreferred = spawnSync(process.execPath, [stateDirectoryScript, "resolve", root], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...defaultStateEnvironment(),
        YOURCHAR_STATE_DIR: "",
        RP_AGENT_STATE_DIR: legacyConfigured,
      },
    });
    assert.notEqual(emptyPreferred.status, 0);
    assert.match(emptyPreferred.stderr, /YOURCHAR_STATE_DIR is set but empty/u);

    const conflict = spawnSync(process.execPath, [stateDirectoryScript, "resolve", root], {
      cwd: projectRoot,
      encoding: "utf8",
      env: defaultStateEnvironment(),
    });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /both \.yourchar and legacy \.rp-agent exist/u);

    rmSync(current, { recursive: true });
    assert.equal(resolveWithEnvironment(root, {}), legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-directory resolution rejects unsafe default sibling entry types", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-state-entry-type-"));
  const symlinkTarget = join(root, "symlink-target");
  try {
    mkdirSync(symlinkTarget, { mode: 0o700 });
    for (const name of [".yourchar", ".rp-agent"]) {
      const statePath = join(root, name);
      for (const kind of ["file", "symlink", "fifo"] as const) {
        if (kind === "file") writeFileSync(statePath, "not a directory\n");
        else if (kind === "symlink") symlinkSync(symlinkTarget, statePath, "dir");
        else execFileSync("mkfifo", [statePath]);

        const result = spawnSync(process.execPath, [stateDirectoryScript, "resolve", root], {
          cwd: projectRoot,
          encoding: "utf8",
          env: defaultStateEnvironment(),
        });
        assert.notEqual(result.status, 0, `${name} ${kind}`);
        assert.match(result.stderr, /must be a real directory/u);
        rmSync(statePath, { force: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state migration performs one identity-preserving rename and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-state-migration-"));
  const legacy = join(root, ".rp-agent");
  const current = join(root, ".yourchar");
  try {
    mkdirSync(legacy, { mode: 0o755 });
    chmodSync(legacy, 0o755);
    writeFileSync(join(legacy, "user-profile.md"), "# migrate me\n", { mode: 0o600 });
    const before = lstatSync(legacy);
    assert.equal(runMigration("preflight", root), "migrate");

    const lockPath = join(root, ".yourchar-state-migration.lock");
    writeFileSync(lockPath, "held\n", { mode: 0o600 });
    const locked = spawnSync(process.execPath, [migrationScript, "migrate", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(locked.status, 0);
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(current), false);
    rmSync(lockPath);

    assert.equal(runMigration("migrate", root), current);
    const after = lstatSync(current);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o700);
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(runMigration("preflight", root), "ready");

    mkdirSync(legacy, { mode: 0o700 });
    const ambiguous = spawnSync(process.execPath, [migrationScript, "preflight", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /migration is ambiguous/u);
    rmSync(legacy, { recursive: true });

    rmSync(current, { recursive: true });
    mkdirSync(join(root, "target"), { mode: 0o700 });
    symlinkSync(join(root, "target"), legacy, "dir");
    const symlink = spawnSync(process.execPath, [migrationScript, "preflight", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(symlink.status, 0);
    assert.match(symlink.stderr, /must be a real directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state migration rejects unsafe or malformed writer state without renaming", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-state-writer-"));
  const cases = [
    { name: "missing-singleton", expected: /no singleton row/u },
    { name: "invalid-expiration", expected: /no valid expiration/u },
    { name: "symlink-database", expected: /regular non-symlink file/u },
  ] as const;
  try {
    for (const fixture of cases) {
      const parent = join(root, fixture.name);
      const legacy = join(parent, ".rp-agent");
      const current = join(parent, ".yourchar");
      const lock = join(parent, ".yourchar-state-migration.lock");
      mkdirSync(legacy, { recursive: true, mode: 0o700 });
      const databasePath = join(legacy, "rp-agent.sqlite");
      if (fixture.name === "symlink-database") {
        const target = join(parent, "database-target");
        writeFileSync(target, "not opened\n", { mode: 0o600 });
        symlinkSync(target, databasePath);
      } else {
        const database = new DatabaseSync(databasePath);
        try {
          database.exec(`
            CREATE TABLE memory_vault_writer_lease (
              singleton INTEGER PRIMARY KEY,
              owner_id TEXT,
              expires_at TEXT
            )
          `);
          if (fixture.name === "invalid-expiration") {
            database.prepare(`
              INSERT INTO memory_vault_writer_lease (singleton, owner_id, expires_at)
              VALUES (1, 'writer', 'not-a-date')
            `).run();
          }
        } finally {
          database.close();
        }
      }

      const result = spawnSync(process.execPath, [migrationScript, "migrate", parent], {
        cwd: projectRoot,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, fixture.name);
      assert.match(result.stderr, fixture.expected);
      assert.equal(existsSync(legacy), true);
      assert.equal(existsSync(current), false);
      assert.equal(existsSync(lock), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer refuses unrelated or custom existing units before stopping or overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-installer-preflight-"));
  const fakeBin = join(root, "bin");
  const fakeSystemctl = join(fakeBin, "systemctl");
  mkdirSync(fakeBin, { mode: 0o700 });
  writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
case "$*" in
  "--user cat rp-agent.service") exit 0 ;;
  "--user show --property=WorkingDirectory --value rp-agent.service")
    printf '%s\\n' "$FAKE_WORKING_DIRECTORY"
    ;;
  "--user show --property=ExecStart --value rp-agent.service")
    printf '%s\\n' "$FAKE_EXEC_START"
    ;;
  "--user show --property=Environment --value rp-agent.service")
    printf '%s\\n' "$FAKE_UNIT_ENVIRONMENT"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeSystemctl, 0o700);

  const cases = [
    {
      name: "other-project",
      workingDirectory: join(root, "other-project"),
      execStart: `${process.execPath} ${join(projectRoot, "dist", "src", "server.js")}`,
      unitEnvironment: "",
      expected: /belongs to a different project/u,
    },
    {
      name: "empty-working-directory",
      workingDirectory: "",
      execStart: `${process.execPath} ${join(projectRoot, "dist", "src", "server.js")}`,
      unitEnvironment: "",
      expected: /WorkingDirectory=<empty>/u,
    },
    {
      name: "other-entrypoint",
      workingDirectory: projectRoot,
      execStart: `${process.execPath} /srv/another-project/dist/src/server.js`,
      unitEnvironment: "",
      expected: /does not run this project's dist\/src\/server\.js/u,
    },
    {
      name: "custom-state",
      workingDirectory: projectRoot,
      execStart: `${process.execPath} ${join(projectRoot, "dist", "src", "server.js")}`,
      unitEnvironment: "YOURCHAR_STATE_DIR=/srv/custom-yourchar",
      expected: /migrate the custom drop-in manually/u,
    },
  ] as const;
  try {
    for (const fixture of cases) {
      const fixtureRoot = join(root, fixture.name);
      const log = join(fixtureRoot, "systemctl.log");
      const config = join(fixtureRoot, "config");
      mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
      const result = spawnSync("bash", [installerScript], {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...defaultStateEnvironment(),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          HOME: fixtureRoot,
          XDG_CONFIG_HOME: config,
          FAKE_SYSTEMCTL_LOG: log,
          FAKE_WORKING_DIRECTORY: fixture.workingDirectory,
          FAKE_EXEC_START: fixture.execStart,
          FAKE_UNIT_ENVIRONMENT: fixture.unitEnvironment,
        },
      });
      assert.notEqual(result.status, 0, fixture.name);
      assert.match(result.stderr, fixture.expected);
      assert.doesNotMatch(readFileSync(log, "utf8"), /--user stop/u);
      assert.equal(existsSync(join(config, "systemd", "user", "rp-agent.service")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment assets use .yourchar while retaining legacy service and database identifiers", () => {
  const installer = readFileSync(installerScript, "utf8");
  const service = readFileSync(join(projectRoot, "ops", "rp-agent.service.in"), "utf8");
  const backupContract = readFileSync(join(projectRoot, "scripts", "backup-contract.mjs"), "utf8");
  const migrator = readFileSync(migrationScript, "utf8");
  const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf8");
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");

  assert.match(installer, /project_dir\/\.yourchar/u);
  assert.match(installer, /rp-agent\.service/u);
  assert.match(installer, /migrate-state-directory\.mjs" preflight/u);
  assert.match(installer, /systemctl --user stop rp-agent\.service/u);
  assert.match(installer, /migrate-state-directory\.mjs" migrate/u);
  assert.match(installer, /systemctl --user start rp-agent\.service/u);
  assert.match(installer, /show --property=WorkingDirectory --value rp-agent\.service/u);
  assert.match(installer, /show --property=ExecStart --value rp-agent\.service/u);
  assert.match(installer, /show --property=Environment --value rp-agent\.service/u);
  assert.match(installer, /different project/u);
  assert.match(installer, /custom state-directory configuration/u);
  assert.match(installer, /install -d -m 700/u);
  assert.match(installer, /backup-state\.mjs" "\$legacy_state_dir" "\$backup_destination"/u);
  assert.match(installer, /Verified pre-migration backup/u);
  assert.match(installer, /mktemp -- "\$unit_dir\/\.rp-agent\.service\.XXXXXX"/u);
  assert.match(installer, /mv -f -- "\$unit_staging" "\$unit_path"/u);
  assert.match(installer, /http:\/\/127\.0\.0\.1:8765\/api\/v1\/readiness/u);
  assert.match(installer, /readiness_deadline=\$\(\(SECONDS \+ 30\)\)/u);
  assert.match(installer, /show --property=MainPID --value rp-agent\.service/u);
  assert.match(installer, /journalctl --user -u rp-agent\.service --no-pager -n 100/u);
  assert.doesNotMatch(installer, /> "\$unit_path"/u);
  assert.doesNotMatch(installer, /mkdir -p[^\n]+\.yourchar/u);
  assert.ok(
    installer.indexOf("migrate-state-directory.mjs\" preflight") <
      installer.indexOf("systemctl --user stop rp-agent.service"),
  );
  assert.ok(
    installer.indexOf("systemctl --user stop rp-agent.service") <
      installer.indexOf("scripts/backup-state.mjs"),
  );
  assert.ok(
    installer.indexOf("scripts/backup-state.mjs") <
      installer.indexOf('migrate-state-directory.mjs" migrate'),
  );
  assert.ok(
    installer.indexOf('"$project_dir/ops/rp-agent.service.in" > "$unit_staging"') <
      installer.indexOf("systemctl --user restart rp-agent.service"),
  );
  assert.ok(
    installer.indexOf("systemctl --user restart rp-agent.service") <
      installer.indexOf('readiness_url="http://127.0.0.1:8765/api/v1/readiness"'),
  );
  assert.match(service, /Environment="YOURCHAR_STATE_DIR=__PROJECT_DIR__\/\.yourchar"/u);
  assert.match(service, /ReadWritePaths=__PROJECT_DIR__\/\.yourchar/u);
  assert.doesNotMatch(service, /ReadWritePaths=.*\.rp-agent/u);
  assert.match(backupContract, /rp-agent\.sqlite/u);
  assert.match(migrator, /O_EXCL[^\n]+O_NOFOLLOW/u);
  assert.match(migrator, /lstatSync/u);
  assert.match(migrator, /assertWriterInactive/u);
  assert.match(migrator, /renameSync\(locked\.legacy, locked\.current\)/u);
  assert.match(migrator, /actual\.dev !== expected\.dev \|\| actual\.ino !== expected\.ino/u);
  assert.match(migrator, /fsyncDirectory\(locked\.parent\)/u);
  assert.match(packageJson, /"migrate:state"/u);
  assert.match(gitignore, /^\.yourchar\/$/mu);
  assert.match(gitignore, /^\.yourchar-ephemeral\/$/mu);
  assert.match(gitignore, /^\.yourchar-state-migration\.lock$/mu);
  assert.match(gitignore, /^\.rp-agent\/$/mu);
});

function defaultStateEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.YOURCHAR_STATE_DIR;
  delete environment.RP_AGENT_STATE_DIR;
  return environment;
}

function resolveWithEnvironment(
  root: string,
  values: { YOURCHAR_STATE_DIR?: string; RP_AGENT_STATE_DIR?: string },
): string {
  return execFileSync(process.execPath, [stateDirectoryScript, "resolve", root], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...defaultStateEnvironment(), ...values },
  }).trim();
}

function runMigration(command: "preflight" | "migrate", root: string): string {
  return execFileSync(process.execPath, [migrationScript, command, root], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}
