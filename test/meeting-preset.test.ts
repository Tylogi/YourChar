import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import type { TestRuntime } from "../src/testing/runtime.js";
import { createTestRuntime } from "../src/testing/index.js";

test("SillyTavern import takes enabled state from the selected prompt_order and only warns about extensions", () => {
  const runtime = createTestRuntime({ seed: "meeting-preset-import" });
  try {
    const imported = runtime.kernel.importMeetingPreset({
      name: "双鱼座默认顺序",
      source: sillyTavernPresetSource(),
    });

    assert.equal(imported.importInfo.promptOrderCharacterId, "100001");
    assert.deepEqual(
      imported.importInfo.availablePromptOrders,
      [
        { characterId: "100000", promptCount: 6, enabledPromptCount: 2 },
        { characterId: "100001", promptCount: 5, enabledPromptCount: 4 },
      ],
    );
    assert.deepEqual(
      imported.prompts.filter((prompt) => prompt.enabled).map((prompt) => prompt.identifier),
      ["set-tone", "preset-before", "chatHistory", "preset-after"],
    );
    assert.equal(
      imported.prompts.find((prompt) => prompt.identifier === "preset-before")?.enabled,
      true,
      "prompt_order must be able to enable a source prompt whose own enabled flag is false",
    );
    assert.equal(
      imported.prompts.find((prompt) => prompt.identifier === "disabled-by-order")?.enabled,
      false,
      "prompt_order must be able to disable a source prompt whose own enabled flag is true",
    );
    assert.equal(
      imported.prompts.find((prompt) => prompt.identifier === "preset-after")?.role,
      "assistant",
      "SillyTavern's model role maps to an assistant provider message",
    );
    assert.deepEqual(imported.importInfo.ignoredExtensionKeys, [
      "regex_scripts",
      "chat_squash",
    ]);
    assert.deepEqual(imported.importInfo.unsupportedParameterKeys, [
      "top_k",
      "reasoning_effort",
    ]);
    assert.equal(
      imported.importInfo.warnings.some((warning) =>
        warning.includes("扩展脚本不会执行") &&
        warning.includes("regex_scripts") &&
        warning.includes("chat_squash")
      ),
      true,
    );

    const specified = runtime.kernel.importMeetingPreset({
      name: "显式旧顺序",
      source: sillyTavernPresetSource(),
      promptOrderCharacterId: "100000",
    });
    assert.equal(specified.importInfo.promptOrderCharacterId, "100000");
    assert.deepEqual(
      specified.prompts.filter((prompt) => prompt.enabled).map((prompt) => prompt.identifier),
      ["alternate-order-only", "disabled-by-order"],
    );
  } finally {
    runtime.dispose();
  }
});

test("a character-bound Tavern preset only orchestrates co-present turns and stops after meeting exit", async () => {
  const runtime = createTestRuntime({
    seed: "meeting-preset-runtime",
    now: "2026-07-29T12:34:00.000Z",
    timezone: "Asia/Shanghai",
  });
  try {
    runtime.kernel.updateUserProfile("# 用户画像\n\n称呼：阿澈\n");
    const preset = runtime.kernel.importMeetingPreset({
      name: "双鱼座运行态",
      source: sillyTavernPresetSource(),
    });
    const character = runtime.kernel.createCharacter({
      name: "夏瑾",
      meetingPresetId: preset.id,
    });
    const conversation = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    assert.equal(conversation.mode, "sms");
    assert.equal(conversation.characterId, character.id);
    assert.equal(conversation.canonicalDirect, true);

    const turns = [
      { presence: "remote", user: "远程问题", assistant: "远程回复" },
      { presence: "meeting_pending", user: "约好以后再问", assistant: "等待见面回复" },
      { presence: "co_present", user: "见面后的问题", assistant: "见面回复" },
    ] as const;

    for (const [index, turn] of turns.entries()) {
      if (turn.presence === "meeting_pending") {
        await runtime.kernel.transitionConversationInteraction(conversation.id, {
          action: "propose",
          location: "梧桐树下",
        });
      } else if (turn.presence === "co_present") {
        await runtime.kernel.transitionConversationInteraction(conversation.id, {
          action: "begin",
          userConfirmed: true,
        });
      }
      assert.equal(
        runtime.kernel.getConversationInteraction(conversation.id).state.presence,
        turn.presence,
      );

      runtime.model.enqueue([{ kind: "assistant_text", text: turn.assistant }]);
      await runtime.kernel.sendMessage(conversation.id, {
        mode: "sms",
        characterId: character.id,
        text: turn.user,
        timezone: runtime.timezone,
      });

      const payload = tracePayloadForTurn(runtime, conversation.id, turn.user);
      if (turn.presence === "co_present") {
        assertPresetPayload(
          payload,
          turn.user,
          turn.presence,
          turns[index - 1].assistant,
        );
      } else {
        assertSmsDefaultPayload(payload, turn.user, turn.presence);
      }
      assert.doesNotMatch(
        JSON.stringify(payload),
        /EXTENSION_SHOULD_NOT_RUN/,
        "imported extension scripts are metadata-only and must not alter provider input",
      );

      if (turn.presence === "co_present") {
        assert.equal(payload.temperature, 0.65);
        assert.equal(payload.top_p, 0.8);
        assert.equal(payload.frequency_penalty, 0.15);
        assert.equal(payload.presence_penalty, -0.2);
        assert.equal(payload.max_tokens, 321);
        assert.equal(payload.seed, 42);
      }
    }

    const transcriptBeforeEdit = JSON.stringify(
      await runtime.kernel.getConversationTranscript(conversation.id),
    );
    assert.doesNotMatch(transcriptBeforeEdit, /PRESET_(?:BEFORE|AFTER)/);
    assert.doesNotMatch(transcriptBeforeEdit, /\{\{(?:setvar|getvar)::/);
    assert.doesNotMatch(transcriptBeforeEdit, /EXTENSION_SHOULD_NOT_RUN/);
    for (const turn of turns) {
      assert.match(transcriptBeforeEdit, new RegExp(turn.user));
      assert.match(transcriptBeforeEdit, new RegExp(turn.assistant));
    }

    const beforePrompt = preset.prompts.find((prompt) =>
      prompt.identifier === "preset-before"
    );
    assert.ok(beforePrompt);
    const updated = runtime.kernel.updateMeetingPreset(preset.id, {
      prompts: [{ id: beforePrompt.id, enabled: false }],
    });
    assert.equal(
      updated.prompts.find((prompt) => prompt.id === beforePrompt.id)?.enabled,
      false,
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "关闭分项后的回复" }]);
    await runtime.kernel.sendMessage(conversation.id, {
      mode: "sms",
      characterId: character.id,
      text: "关闭分项后立刻检查",
      timezone: runtime.timezone,
    });
    const disabledPayload = tracePayloadForTurn(
      runtime,
      conversation.id,
      "关闭分项后立刻检查",
    );
    assert.doesNotMatch(JSON.stringify(disabledPayload.messages), /PRESET_BEFORE/);
    assert.match(JSON.stringify(disabledPayload.messages), /PRESET_AFTER tone=琥珀/);

    await runtime.kernel.transitionConversationInteraction(conversation.id, {
      action: "end",
      userConfirmed: true,
    });
    assert.equal(
      runtime.kernel.getConversationInteraction(conversation.id).state.presence,
      "remote",
    );
    runtime.model.enqueue([{ kind: "assistant_text", text: "退出见面后的远程回复" }]);
    await runtime.kernel.sendMessage(conversation.id, {
      mode: "sms",
      characterId: character.id,
      text: "退出见面后检查",
      timezone: runtime.timezone,
    });
    assertSmsDefaultPayload(
      tracePayloadForTurn(runtime, conversation.id, "退出见面后检查"),
      "退出见面后检查",
      "remote",
    );

    assert.equal(runtime.kernel.deleteMeetingPreset(preset.id), true);
    assert.equal(runtime.kernel.getCharacter(character.id).meetingPresetId, undefined);
    assert.equal(
      runtime.kernel.listMeetingPresets().some((entry) => entry.id === preset.id),
      false,
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "删除预设后的回复" }]);
    await runtime.kernel.sendMessage(conversation.id, {
      mode: "sms",
      characterId: character.id,
      text: "删除预设后检查",
      timezone: runtime.timezone,
    });
    const deletedPayload = tracePayloadForTurn(
      runtime,
      conversation.id,
      "删除预设后检查",
    );
    assert.doesNotMatch(
      JSON.stringify(deletedPayload.messages),
      /PRESET_(?:BEFORE|AFTER)/,
    );
  } finally {
    runtime.dispose();
  }
});

test("meeting preset HTTP APIs import, edit, bind, list, and clear a deleted preset", async () => {
  const runtime = createTestRuntime({ seed: "meeting-preset-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const importedResponse = await fetch(`${baseUrl}/api/v1/meeting-presets/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP 预设",
        source: sillyTavernPresetSource(),
        promptOrderCharacterId: 100001,
      }),
    });
    assert.equal(importedResponse.status, 201);
    const imported = (await importedResponse.json() as {
      preset: { id: string; prompts: Array<{ id: string; identifier: string }> };
    }).preset;
    const before = imported.prompts.find((prompt) => prompt.identifier === "preset-before");
    assert.ok(before);

    const patchResponse = await fetch(
      `${baseUrl}/api/v1/meeting-presets/${encodeURIComponent(imported.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parametersEnabled: false,
          prompts: [{ id: before.id, enabled: false }],
        }),
      },
    );
    assert.equal(patchResponse.status, 200);

    const characterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP 夏瑾", meetingPresetId: imported.id }),
    });
    assert.equal(characterResponse.status, 201);
    const character = (await characterResponse.json() as {
      character: { id: string; meetingPresetId?: string };
    }).character;
    assert.equal(character.meetingPresetId, imported.id);

    const listResponse = await fetch(`${baseUrl}/api/v1/meeting-presets`);
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json() as {
      presets: Array<{ id: string; promptCount: number; enabledPromptCount: number }>;
    }).presets;
    assert.deepEqual(
      list.map((preset) => [
        preset.id,
        preset.promptCount,
        preset.enabledPromptCount,
      ]),
      [[imported.id, 6, 3]],
    );

    const deleteResponse = await fetch(
      `${baseUrl}/api/v1/meeting-presets/${encodeURIComponent(imported.id)}`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 200);
    const reboundResponse = await fetch(
      `${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}`,
    );
    assert.equal(reboundResponse.status, 200);
    const rebound = (await reboundResponse.json() as {
      character: { meetingPresetId?: string };
    }).character;
    assert.equal(rebound.meetingPresetId, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

function sillyTavernPresetSource() {
  return {
    temperature: 0.65,
    top_p: 0.8,
    frequency_penalty: 0.15,
    presence_penalty: -0.2,
    openai_max_tokens: 321,
    seed: 42,
    top_k: 40,
    reasoning_effort: "high",
    prompts: [
      {
        identifier: "set-tone",
        name: "共享变量",
        role: "system",
        content: "{{setvar::tone::琥珀}}",
        enabled: false,
        injection_position: 0,
      },
      {
        identifier: "preset-before",
        name: "历史前",
        role: "system",
        content:
          "{{trim}} PRESET_BEFORE char={{char}} user={{user}} last={{lastusermessage}} " +
          "previous={{lastcharmessage}} tone={{getvar::tone}} " +
          "random={{random::a,b,c}} roll={{roll 1d999999}} {{trim}}",
        enabled: false,
        injection_position: 0,
      },
      {
        identifier: "chatHistory",
        name: "聊天记录",
        role: "system",
        content: "",
        enabled: false,
        marker: true,
        injection_position: 0,
      },
      {
        identifier: "preset-after",
        name: "历史后",
        role: "model",
        content: "PRESET_AFTER tone={{getvar::tone}}",
        enabled: false,
        injection_position: 0,
      },
      {
        identifier: "disabled-by-order",
        name: "只能由顺序关闭",
        role: "system",
        content: "ORDER_DISABLED_SENTINEL",
        enabled: true,
        injection_position: 0,
      },
      {
        identifier: "alternate-order-only",
        name: "旧顺序专用",
        role: "system",
        content: "ALTERNATE_ORDER_SENTINEL",
        enabled: false,
        injection_position: 0,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: "alternate-order-only", enabled: true },
          { identifier: "disabled-by-order", enabled: true },
          { identifier: "set-tone", enabled: false },
          { identifier: "preset-before", enabled: false },
          { identifier: "chatHistory", enabled: false },
          { identifier: "preset-after", enabled: false },
        ],
      },
      {
        character_id: 100001,
        order: [
          { identifier: "set-tone", enabled: true },
          { identifier: "preset-before", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "preset-after", enabled: true },
          { identifier: "disabled-by-order", enabled: false },
        ],
      },
    ],
    extensions: {
      regex_scripts: [{
        find_regex: "远程问题",
        replace_string: "EXTENSION_SHOULD_NOT_RUN",
      }],
      chat_squash: {
        enabled: true,
        replacement: "EXTENSION_SHOULD_NOT_RUN",
      },
    },
  };
}

function tracePayloadForTurn(
  runtime: TestRuntime,
  sessionId: string,
  requestText: string,
): Record<string, unknown> {
  const trace = runtime.kernel.recentModelContextTraces(10).find((entry) =>
    entry.sessionId === sessionId &&
    entry.turnKind === "user" &&
    entry.requestText === requestText
  );
  assert.ok(trace, `missing final provider trace for turn: ${requestText}`);
  return trace.payload;
}

function assertPresetPayload(
  payload: Record<string, unknown>,
  currentUserText: string,
  presence: "remote" | "meeting_pending" | "co_present",
  previousCharacterText: string,
): void {
  assert.ok(Array.isArray(payload.messages));
  const messages = payload.messages as Array<Record<string, unknown>>;
  const beforeIndex = messages.findIndex((message) =>
    message.role === "system" &&
    JSON.stringify(message.content).includes(
      `PRESET_BEFORE char=夏瑾 user=阿澈 last=${currentUserText} ` +
        `previous=${previousCharacterText} tone=琥珀`,
    )
  );
  const userIndex = messages.findIndex((message) =>
    message.role === "user" &&
    JSON.stringify(message.content).includes(currentUserText)
  );
  const afterIndex = messages.findIndex((message) =>
    message.role === "assistant" &&
    JSON.stringify(message.content).includes("PRESET_AFTER tone=琥珀")
  );
  assert.ok(beforeIndex > 0, "the immutable RP Agent system message stays ahead of the preset");
  assert.ok(userIndex > beforeIndex, "chat history is inserted after pre-history prompts");
  assert.ok(afterIndex > userIndex, "post-history prompts stay after the real current user turn");
  const serialized = JSON.stringify(messages);
  assert.match(serialized, new RegExp(`presence=\\\\?"${presence}\\\\?"`));
  assert.match(serialized, /random=[abc] roll=\d+/);
  assert.doesNotMatch(serialized, /ORDER_DISABLED_SENTINEL/);
  assert.doesNotMatch(serialized, /ALTERNATE_ORDER_SENTINEL/);
  assert.doesNotMatch(
    serialized,
    /\{\{(?:char|user|lastusermessage|lastcharmessage|setvar|getvar|random|roll)/,
  );
}

function assertSmsDefaultPayload(
  payload: Record<string, unknown>,
  currentUserText: string,
  presence: "remote" | "meeting_pending",
): void {
  assert.ok(Array.isArray(payload.messages));
  const serialized = JSON.stringify(payload.messages);
  assert.match(serialized, new RegExp(currentUserText));
  assert.match(serialized, /阿澈/);
  assert.match(serialized, new RegExp(`presence=\\\\?"${presence}\\\\?"`));
  assert.doesNotMatch(serialized, /PRESET_(?:BEFORE|AFTER)/);
  assert.equal(payload.top_p, undefined);
  assert.equal(payload.frequency_penalty, undefined);
  assert.equal(payload.presence_penalty, undefined);
  assert.equal(payload.seed, undefined);
}
