import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type PublishOperations = {
  remove?: (path: string) => void;
  fsyncDirectory?: (path: string) => void;
  warn?: (message: string) => void;
};

type PublishRestoredState = (
  paths: { staging: string; stateDir: string; previous: string; parent?: string },
  operations?: PublishOperations,
) => void;

const restoreScript = join(process.cwd(), "scripts", "restore-state.mjs");
const restoreModule = await import(pathToFileURL(restoreScript).href) as {
  publishRestoredState: PublishRestoredState;
};
const { publishRestoredState } = restoreModule;

test("restore publication rolls the old state back after the published rename cannot be synced", () => {
  const fixture = createPublicationFixture();
  let fsyncCalls = 0;
  try {
    assert.throws(
      () => publishRestoredState(fixture, {
        fsyncDirectory: () => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw new Error("injected published-state fsync failure");
        },
      }),
      /injected published-state fsync failure/u,
    );

    assert.equal(fsyncCalls, 3, "rollback must sync the restored directory entry");
    assert.equal(readFileSync(join(fixture.stateDir, "sentinel.txt"), "utf8"), "old state\n");
    assert.equal(existsSync(fixture.previous), false, "the old state was atomically moved back");
    assert.equal(existsSync(fixture.staging), false, "the failed publication was removed");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("restore rollback keeps an undeletable failed publication quarantined without losing old state", () => {
  const fixture = createPublicationFixture();
  const warnings: string[] = [];
  let fsyncCalls = 0;
  try {
    assert.throws(
      () => publishRestoredState(fixture, {
        fsyncDirectory: () => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw new Error("injected published-state fsync failure");
        },
        remove: (path) => {
          if (path === fixture.staging) throw new Error("injected quarantine cleanup failure");
          rmSync(path, { recursive: true, force: true });
        },
        warn: (message) => warnings.push(message),
      }),
      /injected published-state fsync failure/u,
    );

    assert.equal(readFileSync(join(fixture.stateDir, "sentinel.txt"), "utf8"), "old state\n");
    assert.equal(readFileSync(join(fixture.staging, "sentinel.txt"), "utf8"), "new state\n");
    assert.equal(existsSync(fixture.previous), false);
    assert.match(warnings.join("\n"), /failed restored state remains quarantined/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("failure to clean previous state is a post-commit warning, not a destructive rollback", () => {
  const fixture = createPublicationFixture();
  const warnings: string[] = [];
  try {
    assert.doesNotThrow(() => publishRestoredState(fixture, {
      remove: (path) => {
        if (path === fixture.previous) throw new Error("injected previous cleanup failure");
        rmSync(path, { recursive: true, force: true });
      },
      fsyncDirectory: () => undefined,
      warn: (message) => warnings.push(message),
    }));

    assert.equal(readFileSync(join(fixture.stateDir, "sentinel.txt"), "utf8"), "new state\n");
    assert.equal(readFileSync(join(fixture.previous, "sentinel.txt"), "utf8"), "old state\n");
    assert.equal(existsSync(fixture.staging), false);
    assert.match(warnings.join("\n"), /previous state cleanup remains/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

function createPublicationFixture() {
  const parent = mkdtempSync(join(tmpdir(), "yourchar-restore-publication-"));
  const stateDir = join(parent, "state");
  const staging = join(parent, ".restore-staging");
  const previous = join(parent, ".restore-previous");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(join(stateDir, "sentinel.txt"), "old state\n");
  writeFileSync(join(staging, "sentinel.txt"), "new state\n");
  return { parent, stateDir, staging, previous };
}
