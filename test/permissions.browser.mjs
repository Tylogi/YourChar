import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runPermissionChecks(browser) {
  const runtime = createTestRuntime({ seed: "permission-browser" });
  runtime.kernel.patchModelApiConfig({ enabled: false });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem("yourchar.locale", "en"));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.locator("#managementBtn").click();
    await page.locator("#modulesTabBtn").click();
    await page.waitForFunction(() => state.agentPermissions?.workspaceAccess === "read_write");
    assert.match(await page.locator('[data-workspace-access="read_write"]').getAttribute("class"), /active/);
    assert.equal(await page.locator("#shellPermissionInput").isChecked(), false);
    assert.equal(await page.locator("#networkPermissionInput").isDisabled(), true);

    // Mock only the control-plane response to exercise all platform UI branches.
    // Actual OS containment is tested separately by shell-sandbox.test.ts.
    let permissions = { ...runtime.kernel.getAgentPermissions(), shellAvailable: true,
      shellBackend: "bubblewrap", shellNetworkIsolationAvailable: true };
    const patches = [];
    await page.route("**/api/v1/agent-permissions", async route => {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        permissions = { ...permissions, ...patch,
          networkEnabled: patch.shellEnabled === false ? false : patch.networkEnabled ?? permissions.networkEnabled };
      }
      await route.fulfill({ json: { permissions } });
    });
    await page.evaluate(() => loadAgentPermissions());
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator("#shellPermissionInput").click();
    assert.equal(await page.locator("#shellPermissionInput").isChecked(), false);
    assert.equal(patches.length, 0, "cancelled consent must not change permissions");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#shellPermissionInput").click();
    await page.waitForFunction(() => state.agentPermissions?.shellEnabled === true);
    assert.deepEqual(patches.at(-1), { shellEnabled: true }, "Linux must not overwrite an explicit offline choice");
    assert.equal(await page.locator("#networkPermissionInput").isDisabled(), false);

    permissions = { ...permissions, shellEnabled: false, networkEnabled: false,
      shellBackend: "seatbelt", shellNetworkIsolationAvailable: false };
    await page.evaluate(() => loadAgentPermissions());
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#shellPermissionInput").click();
    await page.waitForFunction(() => state.agentPermissions?.networkEnabled === true);
    assert.deepEqual(patches.at(-1), { shellEnabled: true, networkEnabled: true });
    assert.equal(await page.locator("#networkPermissionInput").isChecked(), true);
    assert.equal(await page.locator("#networkPermissionInput").isDisabled(), true);
    await page.waitForFunction(() => document.querySelector("#networkPermissionInput").title.includes("host network"));
    assert.match(await page.locator("#permissionRuntime").textContent(), /macOS Seatbelt/);

    permissions = { ...permissions, shellEnabled: false, networkEnabled: false,
      shellAvailable: false, shellUnavailableReason: "Fixture: sandbox probe failed" };
    await page.evaluate(() => loadAgentPermissions());
    assert.equal(await page.locator("#shellPermissionInput").isDisabled(), true);
    assert.match(await page.locator("#permissionRuntime").textContent(), /sandbox probe failed/);
    assert.deepEqual(errors, []);
    console.log("Permission UI checks passed (defaults, consent, offline preference, native networking, unavailable backend)");
  } finally {
    await page.close();
    await new Promise(resolvePromise => server.close(resolvePromise));
    runtime.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await launch({ headless: true });
  try { await runPermissionChecks(browser); } finally { await browser.close(); }
}
