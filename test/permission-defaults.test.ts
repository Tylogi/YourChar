import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { AgentPermissionCatalog } from "../src/modules/permissions.js";
import { AppDatabase } from "../src/storage/database.js";
import { shellSandboxAvailability } from "../src/execution/shell-sandbox.js";

test("new Workspaces are read-write but explicit historical access choices survive reconstruction", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-permission-default-"));
  const database = new AppDatabase(":memory:");
  const clock = new VirtualClock("2026-09-19T00:00:00.000Z");
  const create = () => new AgentPermissionCatalog(database, clock, join(root, "workspace"));
  try {
    assert.equal(create().get().workspaceAccess, "read_write");
    assert.equal(create().get().shellEnabled, false);
    for (const workspaceAccess of ["off", "read_only", "read_write"] as const) {
      create().update({ workspaceAccess });
      const saved = create().get();
      assert.equal(saved.workspaceAccess, workspaceAccess);
      assert.equal(saved.shellEnabled, false);
      assert.equal(saved.networkEnabled, false);
    }
    // A partial historical record is explicit; it must not inherit new grants.
    database.connection.prepare("DELETE FROM agent_module_settings WHERE module_id = 'permission:workspace-write'").run();
    assert.equal(create().get().workspaceAccess, "read_only");
    database.connection.prepare("UPDATE agent_module_settings SET enabled = 0 WHERE module_id = 'permission:workspace-read'").run();
    assert.equal(create().get().workspaceAccess, "off");
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("enabling a new shell allows networking, but retains an explicit supported offline choice", {
  skip: !shellSandboxAvailability().available,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-network-default-"));
  const database = new AppDatabase(":memory:");
  const catalog = new AgentPermissionCatalog(database, new VirtualClock("2026-09-19T00:00:00.000Z"), root);
  try {
    catalog.update({ userProfileWriteEnabled: false });
    const enabled = catalog.update({ shellEnabled: true });
    assert.equal(enabled.networkEnabled, true);
    assert.equal(enabled.workspaceAccess, "read_write");
    assert.equal(catalog.update({ shellEnabled: false }).networkEnabled, false);
    assert.throws(() => catalog.update({ networkEnabled: true }), /shell execution must be enabled/);
    catalog.update({ shellEnabled: true });
    if (enabled.shellNetworkIsolationAvailable) {
      catalog.update({ networkEnabled: false });
      catalog.update({ shellEnabled: false });
      assert.equal(catalog.update({ shellEnabled: true }).networkEnabled, false);
    } else {
      assert.throws(() => catalog.update({ networkEnabled: false }), /host network/);
      database.connection.prepare("UPDATE agent_module_settings SET enabled = 0 WHERE module_id = 'permission:workspace-network'").run();
      assert.equal(catalog.get().shellEnabled, false, "an old offline shell must never silently become online");
    }
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});
