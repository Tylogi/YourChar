import assert from "node:assert/strict";
import test from "node:test";
import { CompanionStore } from "../src/domain/store.js";
import type { ActionRecord, ConversationSpace } from "../src/domain/types.js";
import {
  characterSkillMcpToolNames,
  createCharacterSkillMcpBridge,
  type CharacterSkillMcpContext,
  type CharacterSkillPrivatePackage,
  type CharacterSkillPrivatePackageService,
} from "../src/mcp/index.js";
import type { AgentModule } from "../src/modules/types.js";
import type {
  CharacterOwnedSkillCreateInput,
  CharacterOwnedSkillPackage,
  CharacterOwnedSkillVersion,
} from "../src/organization/types.js";

const characterId = "character-bound";
const sessionId = "character-skill-session";
const activeMarkdown = "# Active workflow\n\nACTIVE_WORKFLOW_PRIVATE_BODY_SENTINEL";
const draftMarkdown = "# Draft workflow\n\nDRAFT_WORKFLOW_BODY_WITH_ENOUGH_DETAIL_TO_BE_VALID";

test("character Skill MCP exposes only bounded role tools and forces workflow changes to drafts", async () => {
  const activeVersion = ownedVersion({
    id: "version-active",
    status: "active",
    markdown: activeMarkdown,
    activatedAt: "2026-08-25T00:00:00.000Z",
  });
  const existing = ownedPackage({ activeVersion });
  const created = ownedPackage({
    id: "skill-created",
    name: "new-workflow",
    status: "draft",
    createdBy: "character",
    activeVersion: undefined,
  });
  const revised = ownedVersion({
    id: "version-revised",
    version: 2,
    status: "draft",
    markdown: draftMarkdown,
    source: "character_created",
    activatedAt: undefined,
  });
  const calls: {
    list?: [string, ConversationSpace | undefined];
    get?: [string, string, ConversationSpace | undefined];
    versions?: [string, string, ConversationSpace | undefined];
    create?: [string, CharacterOwnedSkillCreateInput, ConversationSpace | undefined];
    revise?: Parameters<CharacterSkillMcpContext["characterCapabilities"]["createOwnedSkillVersion"]>;
  } = {};
  const characterCapabilities: CharacterSkillMcpContext["characterCapabilities"] = {
    listOwnedSkills(boundCharacterId, space) {
      calls.list = [boundCharacterId, space];
      return [existing];
    },
    getOwnedSkill(boundCharacterId, skillId, space) {
      calls.get = [boundCharacterId, skillId, space];
      return existing;
    },
    listOwnedSkillVersions(boundCharacterId, skillId, space) {
      calls.versions = [boundCharacterId, skillId, space];
      return [activeVersion];
    },
    createOwnedSkill(boundCharacterId, input, space) {
      calls.create = [boundCharacterId, input, space];
      return created;
    },
    createOwnedSkillVersion(...args) {
      calls.revise = args;
      return revised;
    },
  };
  const harness = createHarness({ characterCapabilities });
  const bridge = await createCharacterSkillMcpBridge(harness.context);
  try {
    const listing = await bridge.client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name), [...characterSkillMcpToolNames]);
    const exposedSurface = listing.tools.map((tool) => tool.name).join("\n");
    assert.doesNotMatch(exposedSurface, /confirm|activate|install_global|global_install/i);
    for (const tool of listing.tools) {
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /characterId|conversationSpace|owner/i);
    }

    const listed = await bridge.client.callTool({
      name: "list_current_character_skills",
      arguments: {},
    });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(calls.list, [characterId, "normal"]);
    assert.doesNotMatch(JSON.stringify(listed), /ACTIVE_WORKFLOW_PRIVATE_BODY_SENTINEL/);

    const read = await bridge.client.callTool({
      name: "read_current_character_skill",
      arguments: { skillId: existing.id },
    });
    assert.equal(read.isError, undefined);
    assert.deepEqual(calls.get, [characterId, existing.id, "normal"]);
    assert.deepEqual(calls.versions, [characterId, existing.id, "normal"]);
    assert.match(JSON.stringify(read), /ACTIVE_WORKFLOW_PRIVATE_BODY_SENTINEL/);

    const create = await bridge.client.callTool({
      name: "create_current_character_skill_draft",
      arguments: {
        name: "new-workflow",
        description: "Reusable workflow",
        tags: ["research"],
        markdown: draftMarkdown,
        autoImprove: false,
      },
      _meta: { "rp-agent/tool-call-id": "create-call" },
    });
    assert.equal(create.isError, undefined);
    assert.ok(calls.create);
    assert.equal(calls.create[0], characterId);
    assert.equal(calls.create[2], "normal");
    assert.equal(calls.create[1].activate, false);
    assert.equal(calls.create[1].createdBy, "character");
    assert.equal(calls.create[1].sourceTaskId, "create-call");
    assert.doesNotMatch(JSON.stringify(create), /DRAFT_WORKFLOW_BODY/);

    const revise = await bridge.client.callTool({
      name: "revise_current_character_skill_draft",
      arguments: {
        skillId: existing.id,
        markdown: draftMarkdown,
        changeSummary: "Capture the improved sequence",
      },
      _meta: { "rp-agent/tool-call-id": "revise-call" },
    });
    assert.equal(revise.isError, undefined);
    assert.ok(calls.revise);
    assert.equal(calls.revise[0], characterId);
    assert.equal(calls.revise[1], existing.id);
    assert.equal(calls.revise[2].activate, false);
    assert.equal(calls.revise[2].source, "character_created");
    assert.equal(calls.revise[2].sourceTaskId, "revise-call");
    assert.equal(calls.revise[3], "normal");

    const ownerInjection = await bridge.client.callTool({
      name: "create_current_character_skill_draft",
      arguments: {
        characterId: "character-victim",
        conversationSpace: "secret",
        name: "injected",
        markdown: draftMarkdown,
      },
    });
    assert.equal(ownerInjection.isError, true);

    for (const action of harness.turnActions) {
      assert.equal(action.conversationSpace, "normal");
      assert.equal(action.secretOwnerCharacterId, undefined);
      assert.equal(action.payload.characterId, characterId);
      assert.doesNotMatch(JSON.stringify(action.payload), /DRAFT_WORKFLOW_BODY|ACTIVE_WORKFLOW_PRIVATE_BODY/);
    }
  } finally {
    await bridge.close();
  }
});

test("local Agent Skill search exposes bound collection metadata without paths or content", async () => {
  const pathSentinel = "/host/private/global-skill/SKILL.md";
  const privateUrlSentinel = "https://source.invalid/private-skill.zip";
  const privateBodySentinel = "PRIVATE_SKILL_MARKDOWN_SENTINEL";
  const modules: AgentModule[] = [
    globalModule({ id: "skill:global-normal", name: "global-normal", source: pathSentinel }),
    globalModule({ id: "skill:global-secret", name: "global-secret", enabledSpaces: ["secret"] }),
    globalModule({ id: "skill:global-disabled", name: "global-disabled", enabled: false }),
    {
      id: "mcp:not-a-skill",
      type: "mcp",
      name: "not-a-skill",
      description: "Not a Skill",
      source: "built-in",
      enabled: true,
      defaultEnabled: true,
      estimatedTokens: 1,
    },
  ];
  const privateEntries = [
    {
      ...privatePackage({ name: "private-enabled" }),
      source: { requestedUrl: privateUrlSentinel },
      manifest: [{ path: "secrets/hidden.md" }],
      skillMarkdown: privateBodySentinel,
    },
    privatePackage({ name: "private-disabled", enabled: false }),
    privatePackage({ name: "private-invalid", integrity: "changed" }),
    privatePackage({ name: "private-other-character", characterId: "character-other" }),
    privatePackage({ name: "private-other-space", conversationSpace: "secret" }),
  ];
  const privateService = privateServiceStub({ list: () => privateEntries });
  const harness = createHarness({
    privatePackageService: privateService,
    moduleCatalog: { listModules: () => modules },
  });
  const bridge = await createCharacterSkillMcpBridge(harness.context);
  try {
    const response = await bridge.client.callTool({
      name: "search_available_agent_skills",
      arguments: { query: "enabled" },
    });
    assert.equal(response.isError, undefined);
    const serialized = JSON.stringify(response);
    assert.match(serialized, /private-enabled/);
    assert.doesNotMatch(serialized, /global-normal|global-secret|global-disabled/);
    assert.doesNotMatch(serialized, /private-disabled|private-invalid|private-other-character|private-other-space/);
    assert.doesNotMatch(serialized, /private\.invalid|SKILL\.md|PRIVATE_SKILL_MARKDOWN_SENTINEL|\/host\/private/);

    const all = await bridge.client.callTool({
      name: "search_available_agent_skills",
      arguments: {},
    });
    const allSerialized = JSON.stringify(all);
    assert.match(allSerialized, /global-normal/);
    assert.match(allSerialized, /private-enabled/);
    assert.match(allSerialized, /private-disabled/);
    assert.match(allSerialized, /private-invalid/);
    assert.doesNotMatch(allSerialized, /global-secret|global-disabled|not-a-skill|private-other-character|private-other-space/);
    assert.doesNotMatch(allSerialized, /private\.invalid|SKILL\.md|PRIVATE_SKILL_MARKDOWN_SENTINEL|\/host\/private/);
  } finally {
    await bridge.close();
  }
});

test("private package enablement is owner-bound, refreshes capabilities, and writes a scoped redacted audit", async () => {
  let setInput: Parameters<CharacterSkillPrivatePackageService["setEnabled"]>[0] | undefined;
  let refreshes = 0;
  const privateService = privateServiceStub({
    setEnabled(input) {
      setInput = input;
      return privatePackage({
        name: input.name,
        enabled: input.enabled,
        conversationSpace: input.conversationSpace,
      });
    },
  });
  const harness = createHarness({
    conversationSpace: "secret",
    privatePackageService: privateService,
    requestCapabilityRefresh: () => {
      refreshes += 1;
    },
  });
  const bridge = await createCharacterSkillMcpBridge(harness.context);
  try {
    const response = await bridge.client.callTool({
      name: "set_current_character_private_skill_enabled",
      arguments: { name: "private-enabled", enabled: false },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(setInput, {
      characterId,
      conversationSpace: "secret",
      name: "private-enabled",
      enabled: false,
    });
    assert.equal(refreshes, 1);
    assert.equal(harness.turnActions.length, 1);
    assert.equal(harness.turnActions[0].conversationSpace, "secret");
    assert.equal(harness.turnActions[0].secretOwnerCharacterId, characterId);
    assert.equal(harness.turnActions[0].payload.characterId, characterId);
    assert.doesNotMatch(JSON.stringify(response), /source|manifest|markdown|https?:\/\//i);
    assert.doesNotMatch(JSON.stringify(harness.turnActions[0].payload), /source|manifest|markdown|https?:\/\//i);
  } finally {
    await bridge.close();
  }
});

test("remote install requests require a verbatim current-turn URL and expose only a redacted quarantine review", async () => {
  const approvedUrl = "https://github.com/example/skills/tree/main/demo";
  const rejectedUrl = "https://github.com/example/skills/tree/main/not-mentioned";
  const markdownSentinel = "REMOTE_SKILL_MARKDOWN_SENTINEL";
  const manifestPathSentinel = "references/private-notes.md";
  let currentUserText = `请预检这个 Skill：${approvedUrl}`;
  const stageInputs: Array<Parameters<CharacterSkillPrivatePackageService["stage"]>[0]> = [];
  let cancelInput: Parameters<CharacterSkillPrivatePackageService["cancel"]>[0] | undefined;
  const privateService = privateServiceStub({
    async stage(input) {
      stageInputs.push(input);
      return {
        stageId: "stage-secret-token",
        digest: "a".repeat(64),
        archiveSha256: "b".repeat(64),
        expiresAt: "2026-08-26T10:10:00.000Z",
        metadata: {
          name: "remote-demo",
          description: "Remote demo Skill",
          files: 3,
          unpackedBytes: 12_345,
        },
        source: {
          requestedUrl: approvedUrl,
          resolvedArchiveUrl: "https://codeload.github.com/example/skills/archive.zip",
          finalArchiveUrl: "https://codeload.github.com/example/skills/final.zip",
        },
        manifest: [{ path: manifestPathSentinel, size: 12, sha256: "c".repeat(64) }],
        skillMarkdown: markdownSentinel,
      };
    },
    cancel(input) {
      cancelInput = input;
      return true;
    },
  });
  const harness = createHarness({
    conversationSpace: "secret",
    privatePackageService: privateService,
    currentUserText: () => currentUserText,
  });
  const bridge = await createCharacterSkillMcpBridge(harness.context);
  try {
    const blocked = await bridge.client.callTool({
      name: "request_current_character_skill_install",
      arguments: { sourceUrl: rejectedUrl },
    });
    assert.equal(blocked.isError, true);
    assert.equal(stageInputs.length, 0);
    assert.doesNotMatch(JSON.stringify(blocked), /not-mentioned/);
    assert.equal(harness.turnActions[0].status, "blocked");

    const staged = await bridge.client.callTool({
      name: "request_current_character_skill_install",
      arguments: { sourceUrl: approvedUrl },
    });
    assert.equal(staged.isError, undefined);
    assert.deepEqual(stageInputs, [{
      characterId,
      conversationSpace: "secret",
      sourceUrl: approvedUrl,
    }]);
    const serialized = JSON.stringify(staged);
    assert.match(serialized, /reviewId/);
    assert.match(serialized, /stage-secret-token/);
    assert.match(serialized, /remote-demo/);
    assert.match(serialized, /Remote demo Skill/);
    assert.match(serialized, /"fileCount":3/);
    assert.doesNotMatch(serialized, /github\.com|codeload\.github\.com/);
    assert.doesNotMatch(serialized, /REMOTE_SKILL_MARKDOWN_SENTINEL|private-notes\.md|archiveSha256|unpackedBytes|manifest/);

    const cancelled = await bridge.client.callTool({
      name: "cancel_current_character_skill_install",
      arguments: { reviewId: "stage-secret-token" },
    });
    assert.equal(cancelled.isError, undefined);
    assert.deepEqual(cancelInput, {
      characterId,
      conversationSpace: "secret",
      stageId: "stage-secret-token",
    });

    assert.equal(harness.turnActions.length, 3);
    for (const action of harness.turnActions) {
      assert.equal(action.conversationSpace, "secret");
      assert.equal(action.secretOwnerCharacterId, characterId);
      assert.equal(action.payload.characterId, characterId);
      const audit = JSON.stringify(action.payload);
      assert.doesNotMatch(audit, /github\.com|codeload\.github\.com/);
      assert.doesNotMatch(audit, /REMOTE_SKILL_MARKDOWN_SENTINEL|private-notes\.md|manifest|sourceUrl/);
    }

    currentUserText = "下一轮已不再包含该 URL";
    const staleTurn = await bridge.client.callTool({
      name: "request_current_character_skill_install",
      arguments: { sourceUrl: approvedUrl },
    });
    assert.equal(staleTurn.isError, true);
    assert.equal(stageInputs.length, 1);
  } finally {
    await bridge.close();
  }
});

function createHarness(overrides: Partial<CharacterSkillMcpContext> = {}) {
  const store = new CompanionStore({ stateDir: false });
  const turnActions: ActionRecord[] = [];
  const context: CharacterSkillMcpContext = {
    characterCapabilities: inertCharacterCapabilities(),
    privatePackageService: privateServiceStub(),
    moduleCatalog: { listModules: () => [] },
    store,
    sessionId,
    characterId,
    conversationSpace: "normal",
    currentUserText: () => "",
    actions: () => turnActions,
    requestCapabilityRefresh: () => undefined,
    ...overrides,
  };
  return { context, turnActions, store };
}

function inertCharacterCapabilities(): CharacterSkillMcpContext["characterCapabilities"] {
  const skill = ownedPackage();
  const version = skill.activeVersion!;
  return {
    listOwnedSkills: () => [skill],
    getOwnedSkill: () => skill,
    listOwnedSkillVersions: () => [version],
    createOwnedSkill: () => skill,
    createOwnedSkillVersion: () => version,
  };
}

function privateServiceStub(
  overrides: Partial<CharacterSkillPrivatePackageService> = {},
): CharacterSkillPrivatePackageService {
  return {
    list: () => [],
    setEnabled: (input) => privatePackage({
      name: input.name,
      enabled: input.enabled,
      conversationSpace: input.conversationSpace,
    }),
    stage: async () => ({
      stageId: "stage",
      digest: "a".repeat(64),
      expiresAt: "2026-08-26T10:10:00.000Z",
      metadata: { name: "remote", description: "Remote Skill", files: 1 },
    }),
    cancel: () => false,
    ...overrides,
  };
}

function ownedPackage(
  overrides: Partial<CharacterOwnedSkillPackage> = {},
): CharacterOwnedSkillPackage {
  const activeVersion = overrides.activeVersion === undefined && !("activeVersion" in overrides)
    ? ownedVersion()
    : overrides.activeVersion;
  return {
    id: "skill-owned",
    characterId,
    conversationSpace: "normal",
    slug: "owned-workflow",
    name: "owned-workflow",
    description: "Character-owned workflow",
    tags: ["workflow"],
    status: activeVersion ? "active" : "draft",
    autoImprove: true,
    createdBy: "user",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...(activeVersion ? { activeVersion } : {}),
    versionCount: 1,
    evaluationCount: 0,
    completedCount: 0,
    failedCount: 0,
    pendingProposalCount: 0,
    ...overrides,
  };
}

function ownedVersion(
  overrides: Partial<CharacterOwnedSkillVersion> = {},
): CharacterOwnedSkillVersion {
  return {
    id: "version-owned",
    packageId: "skill-owned",
    characterId,
    conversationSpace: "normal",
    version: 1,
    status: "active",
    markdown: activeMarkdown,
    changeSummary: "Initial workflow",
    source: "manual",
    contentHash: "d".repeat(64),
    createdAt: "2026-08-25T00:00:00.000Z",
    activatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function privatePackage(
  overrides: Partial<CharacterSkillPrivatePackage> = {},
): CharacterSkillPrivatePackage {
  return {
    characterId,
    conversationSpace: "normal",
    name: "private-skill",
    description: "Private Agent Skill",
    enabled: true,
    integrity: "verified",
    ...overrides,
  };
}

function globalModule(overrides: Partial<AgentModule> = {}): AgentModule {
  return {
    id: "skill:global",
    type: "skill",
    name: "global-skill",
    description: "Global Agent Skill",
    source: "/host/global/SKILL.md",
    enabled: true,
    enabledSpaces: ["normal"],
    defaultEnabled: false,
    estimatedTokens: 100,
    ...overrides,
  };
}
