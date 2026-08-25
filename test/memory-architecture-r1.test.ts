import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import {
  CompanionKernel,
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  RpMemoryValidationError,
  type CreateMemoryInput,
  type Mode,
  type UpdateMemoryInput,
} from "../src/domain/index.js";

type ProviderMessage = {
  role?: string;
  content?: unknown;
};

type ProviderPayload = {
  messages?: ProviderMessage[];
  tools?: unknown[];
  chat_template_kwargs?: Record<string, unknown>;
};

test("realm contracts keep global reality profile separate from character RP memory", () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-11T09:00:15.000Z"),
    startScheduler: false,
  });
  try {
    const profile = kernel.getUserProfile();
    assert.equal(profile.realm, "reality");
    assert.equal(profile.scope, "global");

    const character = kernel.createCharacter({ name: "林澈" });
    const maliciousProposal = {
      realm: RP_MEMORY_REALM,
      scope: RP_MEMORY_SCOPE,
      type: "relationship_event" as const,
      content: "模型试图自行确认的角色约定",
      characterId: character.id,
      confirmed: true,
    };
    const proposal = kernel.rpService.proposeMemory(maliciousProposal);
    assert.equal(proposal.memory?.realm, "roleplay");
    assert.equal(proposal.memory?.scope, "character");
    assert.equal(proposal.memory?.characterId, character.id);
    assert.equal(proposal.memory?.confirmed, false);
    assert.equal(proposal.memory?.validity, "pending");
    assert.ok(proposal.memory);
    const immutableScope = kernel.updateRpMemory(proposal.memory.id, {
      realm: "reality",
      scope: "global",
      characterId: "other-character",
    } as unknown as UpdateMemoryInput);
    assert.equal(immutableScope.realm, "roleplay");
    assert.equal(immutableScope.scope, "character");
    assert.equal(immutableScope.characterId, character.id);

    assert.throws(
      () => kernel.writeRpMemory({
        realm: "reality",
        scope: "global",
        type: "user_fact",
        content: "错误写入 RP 数据库的现实画像",
        characterId: character.id,
        confirmed: true,
      } as unknown as CreateMemoryInput),
      RpMemoryValidationError,
    );
    assert.throws(
      () => kernel.writeRpMemory({
        realm: RP_MEMORY_REALM,
        scope: RP_MEMORY_SCOPE,
        type: "preference",
        content: "现实偏好不得写入角色记忆",
        characterId: character.id,
        confirmed: true,
      } as unknown as CreateMemoryInput),
      (error) => error instanceof RpMemoryValidationError && error.code === "RP_MEMORY_TYPE_INVALID",
    );
  } finally {
    kernel.dispose();
  }
});

test("SMS and RP preserve durable prefix context while replacing the volatile snapshot", async (t) => {
  for (const mode of ["sms", "rp"] as const) {
    await t.test(mode, () => verifyProviderCacheContract(mode));
  }
});

async function verifyProviderCacheContract(mode: Mode): Promise<void> {
  const payloads: ProviderPayload[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderPayload);
    writeChatCompletionStream(response, `reply-${payloads.length}`);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const clock = new VirtualClock("2026-07-11T09:00:15.000Z");
  const kernel = new CompanionKernel({
    stateDir: false,
    clock,
    startScheduler: false,
    quietHours: false,
    characterSkillReflector: false,
  });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "cache-contract-MLX-model",
      temperature: 0,
    });
    kernel.patchAgentPermissions({
      realityMemoryWriteEnabled: true,
      characterMemoryWriteEnabled: true,
    });
    kernel.updateUserProfile("# 用户画像\n\n- 偏好简洁回复。\n");
    const character = kernel.createCharacter({
      name: "林澈",
      soulMarkdown: "# SOUL.md\n\n林澈重视承诺。",
    });
    kernel.writeRpMemory({
      realm: RP_MEMORY_REALM,
      scope: RP_MEMORY_SCOPE,
      type: "relationship_event",
      content: "记得玻璃温室的约定",
      characterId: character.id,
      confirmed: true,
    });
    const sessionId = `cache-${mode}`;
    if (mode === "rp") {
      kernel.updateScene(sessionId, {
        location: "玻璃温室",
        summary: "正在核对旧约定",
      }, character.id);
    }

    await kernel.sendMessage(sessionId, {
      mode,
      characterId: character.id,
      timezone: "Asia/Shanghai",
      text: "还记得玻璃温室的约定吗？",
    });
    clock.advance(125_000);
    if (mode === "rp") {
      kernel.updateScene(sessionId, {
        location: "北侧塔楼",
        summary: "场景已经推进",
      }, character.id);
    }
    await kernel.sendMessage(sessionId, {
      mode,
      characterId: character.id,
      timezone: "Asia/Shanghai",
      text: "现在继续。",
    });

    assert.equal(payloads.length, 2);
    const firstMessages = requireMessages(payloads[0]);
    const secondMessages = requireMessages(payloads[1]);
    const reusablePrefixLength = firstMessages.length - 2;
    assert.equal(longestCommonPrefix(firstMessages, secondMessages), reusablePrefixLength);
    assert.deepEqual(secondMessages.slice(0, reusablePrefixLength), firstMessages.slice(0, reusablePrefixLength));

    assert.equal(firstMessages.at(-1)?.role, "user");
    assert.equal(messageText(firstMessages.at(-1)), "还记得玻璃温室的约定吗？");
    assert.equal(secondMessages.at(-1)?.role, "user");
    assert.equal(messageText(secondMessages.at(-1)), "现在继续。");
    assert.ok(firstMessages.findIndex((message) => JSON.stringify(message).includes("NOT_USER_AUTHORED")) < firstMessages.length - 1);
    assert.ok(secondMessages.findIndex((message) => JSON.stringify(message).includes("NOT_USER_AUTHORED")) < secondMessages.length - 1);
    assert.deepEqual(payloads.map((payload) => payload.chat_template_kwargs), [
      { enable_thinking: true, preserve_thinking: true },
      { enable_thinking: true, preserve_thinking: true },
    ]);

    const firstSystem = requireSystem(firstMessages);
    const secondSystem = requireSystem(secondMessages);
    assert.equal(hash(firstSystem), hash(secondSystem));
    assert.equal(firstSystem, secondSystem);
    assert.doesNotMatch(firstSystem, /Current date:|Current time|2026-07-11 17:0[02]/);
    assert.doesNotMatch(firstSystem, /玻璃温室的约定|北侧塔楼|场景已经推进/);
    assert.match(firstSystem, /realm=reality, scope=global/);
    assert.match(firstSystem, /realm=roleplay, scope=character/);

    const firstJson = JSON.stringify(firstMessages);
    const secondJson = JSON.stringify(secondMessages);
    assert.match(firstJson, /RP_AGENT_TURN_CONTEXT v3/);
    assert.match(firstJson, /2026-07-11 17:00 Asia\/Shanghai/);
    assert.match(firstJson, /记得玻璃温室的约定/);
    assert.doesNotMatch(secondJson, /2026-07-11 17:00 Asia\/Shanghai/);
    assert.match(secondJson, /2026-07-11 17:02 Asia\/Shanghai/);
    assert.equal((firstJson.match(/LATEST_VOLATILE_SNAPSHOT/g) ?? []).length, 1);
    assert.equal((secondJson.match(/LATEST_VOLATILE_SNAPSHOT/g) ?? []).length, 1);
    assert.equal((secondJson.match(/<roleplay_memories>/g) ?? []).length, 1);
    if (mode === "rp") {
      assert.match(firstJson, /Location: 玻璃温室/);
      assert.doesNotMatch(secondJson, /Location: 玻璃温室|正在核对旧约定/);
      assert.match(secondJson, /Location: 北侧塔楼/);
    }

    const proposeMemoryTool = (payloads[0].tools ?? []).find((tool) =>
      JSON.stringify(tool).includes("propose_memory")
    );
    assert.ok(proposeMemoryTool);
    const proposalSchema = JSON.stringify(proposeMemoryTool);
    assert.equal(proposalSchema.includes('"confirmed":'), false);
    if (mode === "rp") {
      assert.equal(proposalSchema.includes('"user_fact"'), false);
      assert.equal(proposalSchema.includes('"preference"'), false);
    } else {
      assert.equal(proposalSchema.includes('"relationship_event"'), false);
      assert.equal(proposalSchema.includes('"plot_event"'), false);
    }

    const rawSession = await kernel.getSession(sessionId);
    assert.deepEqual(rawSession.messages.map((message) => message.role), [
      "user",
      "custom",
      "assistant",
      "user",
      "custom",
      "assistant",
    ]);
    const turnContexts = rawSession.messages.filter((message) =>
      message.role === "custom" && message.customType === "rp-agent/turn_context"
    );
    assert.equal(turnContexts.length, 2);
    assert.equal(turnContexts.every((message) => message.role === "custom" && message.display === false), true);
    assert.equal(turnContexts.every((message) =>
      message.role === "custom" && (message.details as { schemaVersion?: number })?.schemaVersion === 4
    ), true);
  } finally {
    kernel.dispose();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
  }
}

function requireMessages(payload: ProviderPayload | undefined): ProviderMessage[] {
  assert.ok(payload);
  assert.ok(Array.isArray(payload.messages));
  return payload.messages;
}

function requireSystem(messages: ProviderMessage[]): string {
  const message = messages.find((entry) => entry.role === "system" || entry.role === "developer");
  assert.ok(message);
  assert.ok(typeof message.content === "string");
  return message.content;
}

function messageText(message: ProviderMessage | undefined): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("text" in part)) return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("");
}

function longestCommonPrefix(left: ProviderMessage[], right: ProviderMessage[]): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    JSON.stringify(left[length]) === JSON.stringify(right[length])
  ) {
    length += 1;
  }
  return length;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeChatCompletionStream(response: ServerResponse, content: string): void {
  const id = "chatcmpl-cache-contract";
  const created = 1_789_000_000;
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const data of [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      choices: [{
        index: 0,
        delta: { reasoning_content: "核对角色身份、长期记忆与当前用户消息后再组织回复。" },
        finish_reason: null,
      }],
    },
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]) {
    response.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "cache-contract-MLX-model",
      ...data,
    })}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}
