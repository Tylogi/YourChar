import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { CharacterAgentSkillPackageService } from "../src/modules/character-skill-packages.js";
import { AppDatabase } from "../src/storage/database.js";
import { ScriptedModelController } from "../src/testing/runtime.js";

const privateMarkdownSentinel = "CHARACTER_SKILL_PRIVATE_MARKDOWN_SENTINEL";
const privateManifestPath = "references/private-review.md";

test("character Skill HTTP inventory is scoped and full reviews require the local control plane", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-character-skill-http-"));
  const database = new AppDatabase(join(stateDir, "state.sqlite"));
  const packageService = new CharacterAgentSkillPackageService({
    database,
    stateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => ({
      response: new Response(toArrayBuffer(skillArchive(
        request.url.pathname.includes("secret-review") ? "secret-review" : "normal-review",
      )), { headers: { "content-type": "application/zip" } }),
    }),
  });
  const model = new ScriptedModelController("character-skill-http");
  const kernel = new CompanionKernel({
    stateDir,
    database,
    characterSkillPackages: packageService,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    modelResolver: model.resolver,
  });
  kernel.patchModelApiConfig({
    enabled: true,
    baseUrl: "http://test.invalid/v1",
    model: "scripted-model",
    temperature: 0,
  });
  const character = kernel.createCharacter({ name: "Skill HTTP Owner" });
  const otherCharacter = kernel.createCharacter({ name: "Other Owner" });
  const conversation = await kernel.openCanonicalPrivateConversation(character.id);
  const normalStage = await packageService.stage({
    characterId: character.id,
    conversationSpace: "normal",
    sourceUrl: "https://downloads.example.com/normal-review.zip",
  });
  const secretStage = await packageService.stage({
    characterId: character.id,
    conversationSpace: "secret",
    sourceUrl: "https://downloads.example.com/secret-review.zip",
  });
  const server = createHttpServer({ kernel });
  await listen(server);
  try {
    const origin = originOf(server);
    const untrustedPermissionPatch = await fetch(`${origin}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ characterSkillManageEnabled: true }),
    });
    assert.equal(untrustedPermissionPatch.status, 403);
    const permissionResponse = await fetch(`${origin}/api/v1/agent-permissions`);
    assert.equal(permissionResponse.status, 200);
    assert.equal((await permissionResponse.json() as {
      permissions: { characterSkillManageEnabled: boolean };
    }).permissions.characterSkillManageEnabled, false);
    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const trustedHeaders = {
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    const permissionPatch = await fetch(`${origin}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({ characterSkillManageEnabled: true }),
    });
    assert.equal(permissionPatch.status, 200);
    assert.equal((await permissionPatch.json() as {
      permissions: { characterSkillManageEnabled: boolean };
    }).permissions.characterSkillManageEnabled, true);

    const normalStagesResponse = await fetch(
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/skill-package-stages`,
    );
    assert.equal(normalStagesResponse.status, 200);
    const normalStagesText = await normalStagesResponse.text();
    assert.doesNotMatch(normalStagesText, new RegExp(privateMarkdownSentinel));
    assert.doesNotMatch(normalStagesText, new RegExp(privateManifestPath.replace(".", "\\.")));
    assert.doesNotMatch(normalStagesText, /https:\/\/downloads\.example\.com/u);
    const normalStages = JSON.parse(normalStagesText) as {
      stages: Array<Record<string, unknown>>;
    };
    assert.deepEqual(normalStages.stages.map((stage) => stage.reviewId), [normalStage.stageId]);
    assert.equal(normalStages.stages[0].name, "normal-review");
    assert.equal(normalStages.stages[0].digest, normalStage.digest);
    assert.equal(normalStages.stages[0].sourceHost, "downloads.example.com");
    assert.equal("skillMarkdown" in normalStages.stages[0], false);
    assert.equal("manifest" in normalStages.stages[0], false);
    assert.equal("source" in normalStages.stages[0], false);

    const secretWithoutOwner = await fetch(
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/skill-package-stages` +
      "?conversationSpace=secret",
    );
    assert.equal(secretWithoutOwner.status, 400);
    const secretWithWrongOwner = await fetch(
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/skill-package-stages` +
      `?conversationSpace=secret&characterId=${encodeURIComponent(otherCharacter.id)}`,
    );
    assert.equal(secretWithWrongOwner.status, 404);
    const secretStagesResponse = await fetch(
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/skill-package-stages` +
      `?conversationSpace=secret&characterId=${encodeURIComponent(character.id)}`,
    );
    assert.equal(secretStagesResponse.status, 200);
    const secretStages = await secretStagesResponse.json() as {
      stages: Array<{ reviewId: string }>;
    };
    assert.deepEqual(secretStages.stages.map((stage) => stage.reviewId), [secretStage.stageId]);

    const normalStageReviewUrl =
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}` +
      `/skill-package-stages/${encodeURIComponent(normalStage.stageId)}/review`;
    const normalStageReviewBody = {
      stageId: normalStage.stageId,
      characterId: character.id,
      conversationSpace: "normal",
    };
    const untrustedReview = await fetch(normalStageReviewUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(normalStageReviewBody),
    });
    assert.equal(untrustedReview.status, 403);

    model.enqueue([{
      kind: "assistant_text",
      text: "active turn completed",
      delayMs: 500,
    }]);
    const activeTurn = kernel.sendMessage(conversation.id, {
      mode: "sms",
      characterId: character.id,
      text: "keep the capability snapshot active",
    });
    await waitUntil(() => model.requests.length >= 1);
    const busyReview = await fetch(normalStageReviewUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify(normalStageReviewBody),
    });
    assert.equal(busyReview.status, 409);
    assert.equal((await busyReview.json() as { code: string }).code, "CONTROL_PLANE_BUSY");
    const busyPermissionPatch = await fetch(`${origin}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({ characterSkillManageEnabled: false }),
    });
    assert.equal(busyPermissionPatch.status, 409);
    assert.equal(
      (await busyPermissionPatch.json() as { code: string }).code,
      "CONTROL_PLANE_BUSY",
    );
    assert.equal(kernel.getAgentPermissions().characterSkillManageEnabled, true);
    const busyConfirm = await fetch(
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}` +
      `/skill-package-stages/${encodeURIComponent(normalStage.stageId)}/confirm`,
      {
        method: "POST",
        headers: trustedHeaders,
        body: JSON.stringify({
          stageId: normalStage.stageId,
          digest: normalStage.digest,
          enabled: true,
          characterId: character.id,
          conversationSpace: "normal",
        }),
      },
    );
    assert.equal(busyConfirm.status, 409);
    assert.equal((await busyConfirm.json() as { code: string }).code, "CONTROL_PLANE_BUSY");
    const busyExport = await fetch(`${origin}/api/v1/export`);
    assert.equal(busyExport.status, 409);
    assert.equal((await busyExport.json() as { code: string }).code, "CONTROL_PLANE_BUSY");
    const busyDeleteAll = await fetch(`${origin}/api/v1/data`, {
      method: "DELETE",
      headers: trustedHeaders,
      body: JSON.stringify({ confirm: "DELETE_ALL_DATA" }),
    });
    assert.equal(busyDeleteAll.status, 409);
    assert.equal(
      (await busyDeleteAll.json() as { code: string }).code,
      "CONTROL_PLANE_BUSY",
    );
    assert.ok(kernel.listCharacters().some((entry) => entry.id === character.id));
    await activeTurn;

    const trustedReview = await fetch(normalStageReviewUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify(normalStageReviewBody),
    });
    assert.equal(trustedReview.status, 200, await trustedReview.clone().text());
    const reviewedStage = (await trustedReview.json() as {
      stage: {
        stageId: string;
        reviewId: string;
        skillMarkdown: string;
        manifest: Array<{ path: string }>;
        source: { requestedUrl: string };
      };
    }).stage;
    assert.equal(reviewedStage.reviewId, reviewedStage.stageId);
    assert.match(reviewedStage.skillMarkdown, new RegExp(privateMarkdownSentinel));
    assert.equal(reviewedStage.manifest.some((entry) => entry.path === privateManifestPath), true);
    assert.equal(reviewedStage.source.requestedUrl, "https://downloads.example.com/normal-review.zip");

    const confirmUrl =
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}` +
      `/skill-package-stages/${encodeURIComponent(normalStage.stageId)}/confirm`;
    const confirmBody = {
      stageId: normalStage.stageId,
      digest: normalStage.digest,
      enabled: true,
      characterId: character.id,
      conversationSpace: "normal",
    };
    const untrustedConfirm = await fetch(confirmUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(confirmBody),
    });
    assert.equal(untrustedConfirm.status, 403);
    assert.equal(packageService.getStage({
      characterId: character.id,
      conversationSpace: "normal",
      stageId: normalStage.stageId,
    })?.digest, normalStage.digest);
    const wrongScopeConfirm = await fetch(confirmUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify({ ...confirmBody, conversationSpace: "secret" }),
    });
    assert.equal(wrongScopeConfirm.status, 404);
    const confirm = await fetch(confirmUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify(confirmBody),
    });
    assert.equal(confirm.status, 201, await confirm.clone().text());

    const packageCollectionUrl =
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/skill-packages`;
    const packageListResponse = await fetch(packageCollectionUrl);
    assert.equal(packageListResponse.status, 200);
    const packageListText = await packageListResponse.text();
    assert.doesNotMatch(packageListText, new RegExp(privateMarkdownSentinel));
    assert.doesNotMatch(packageListText, new RegExp(privateManifestPath.replace(".", "\\.")));
    assert.doesNotMatch(packageListText, /https:\/\/downloads\.example\.com/u);
    const packageList = JSON.parse(packageListText) as {
      packages: Array<Record<string, unknown>>;
    };
    assert.equal(packageList.packages[0].name, "normal-review");
    assert.equal(packageList.packages[0].enabled, true);
    assert.equal(packageList.packages[0].integrity, "verified");
    assert.equal("skillMarkdown" in packageList.packages[0], false);
    assert.equal("manifest" in packageList.packages[0], false);
    assert.equal("source" in packageList.packages[0], false);

    const packageDetailUrl = `${packageCollectionUrl}/normal-review`;
    const safePackageDetail = await fetch(packageDetailUrl);
    assert.equal(safePackageDetail.status, 200);
    assert.doesNotMatch(await safePackageDetail.text(), new RegExp(privateMarkdownSentinel));
    const packageReviewUrl = `${packageDetailUrl}/review`;
    const packageReviewBody = {
      name: "normal-review",
      characterId: character.id,
      conversationSpace: "normal",
    };
    const untrustedPackageReview = await fetch(packageReviewUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(packageReviewBody),
    });
    assert.equal(untrustedPackageReview.status, 403);
    const packageReview = await fetch(packageReviewUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify(packageReviewBody),
    });
    assert.equal(packageReview.status, 200, await packageReview.clone().text());
    const reviewedPackage = (await packageReview.json() as {
      package: { skillMarkdown: string; manifest: Array<{ path: string }> };
    }).package;
    assert.match(reviewedPackage.skillMarkdown, new RegExp(privateMarkdownSentinel));
    assert.equal(reviewedPackage.manifest.some((entry) => entry.path === privateManifestPath), true);

    const untrustedDisable = await fetch(packageDetailUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        enabled: false,
        characterId: character.id,
        conversationSpace: "normal",
      }),
    });
    assert.equal(untrustedDisable.status, 403);
    assert.equal(packageService.list({
      characterId: character.id,
      conversationSpace: "normal",
    })[0].enabled, true);
    const disable = await fetch(packageDetailUrl, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({
        enabled: false,
        characterId: character.id,
        conversationSpace: "normal",
      }),
    });
    assert.equal(disable.status, 200, await disable.clone().text());
    assert.equal(packageService.list({
      characterId: character.id,
      conversationSpace: "normal",
    })[0].enabled, false);

    const cancelUrl =
      `${origin}/api/v1/characters/${encodeURIComponent(character.id)}` +
      `/skill-package-stages/${encodeURIComponent(secretStage.stageId)}/cancel` +
      `?conversationSpace=secret&characterId=${encodeURIComponent(character.id)}`;
    const cancel = await fetch(cancelUrl, {
      method: "POST",
      headers: trustedHeaders,
      body: JSON.stringify({
        stageId: secretStage.stageId,
        digest: secretStage.digest,
        characterId: character.id,
        conversationSpace: "secret",
      }),
    });
    assert.equal(cancel.status, 200, await cancel.clone().text());
    assert.equal((await cancel.json() as { cancelled: boolean }).cancelled, true);

    const actionTypes = kernel.store.allActions().map((action) => action.actionType);
    assert.equal(actionTypes.includes("confirm_character_agent_skill"), true);
    assert.equal(actionTypes.includes("set_character_agent_skill_enabled"), true);
    assert.equal(actionTypes.includes("cancel_character_agent_skill_review"), true);
    const confirmAction = kernel.store.allActions().find((action) =>
      action.actionType === "confirm_character_agent_skill");
    assert.equal(confirmAction?.conversationSpace, "normal");
    const cancelAction = kernel.store.allActions().find((action) =>
      action.actionType === "cancel_character_agent_skill_review");
    assert.equal(cancelAction?.conversationSpace, "secret");
    assert.equal(cancelAction?.secretOwnerCharacterId, character.id);
  } finally {
    await close(server);
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function skillArchive(name: string): Uint8Array {
  return zipSync({
    "wrapper/SKILL.md": strToU8([
      "---",
      `name: ${name}`,
      "description: A character-private reviewed workflow.",
      "---",
      "",
      "# Character private workflow",
      "",
      privateMarkdownSentinel,
      "",
    ].join("\n")),
    [`wrapper/${privateManifestPath}`]: strToU8("private review material\n"),
  });
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function originOf(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the active model turn");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
