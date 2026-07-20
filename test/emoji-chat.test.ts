import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "../src/testing/runtime.js";

test("user and agent Emoji survive the private-message model and transcript round trip", async () => {
  const runtime = createTestRuntime();
  try {
    const character = runtime.kernel.createCharacter({
      name: "表情角色",
      soulMarkdown: "# SOUL.md\n\n你是表情角色本人，语气自然。",
    });
    runtime.model.enqueue([{ kind: "assistant_text", text: "收到啦 🫶✨ 今晚见。" }]);

    const response = await runtime.kernel.sendMessage("emoji-private", {
      mode: "sms",
      characterId: character.id,
      text: "今天进展顺利 👩‍💻，晚上喝茶吧 ☕️",
    });

    assert.equal(response.reply, "收到啦 🫶✨ 今晚见。");
    const conversation = runtime.kernel.sessionRuntime.getConversationMetadata().find((entry) =>
      entry.mode === "sms" && entry.characterId === character.id);
    assert.ok(conversation);
    const transcript = await runtime.kernel.sessionRuntime.getConversationTranscript(conversation.id);
    const serializedTranscript = JSON.stringify(transcript);
    assert.match(serializedTranscript, /今天进展顺利 👩‍💻，晚上喝茶吧 ☕️/u);
    assert.match(serializedTranscript, /收到啦 🫶✨ 今晚见。/u);

    const request = runtime.model.requests.at(-1);
    assert.ok(request);
    assert.match(request.systemPrompt, /Unicode Emoji/u);
    assert.match(JSON.stringify(request.providerPayload.messages), /今天进展顺利 👩‍💻，晚上喝茶吧 ☕️/u);
    const prompts = runtime.kernel.getSystemPrompts();
    assert.match(prompts.sms.builtIn, /Unicode Emoji/u);
    assert.match(prompts.rp.builtIn, /Unicode Emoji/u);
  } finally {
    runtime.dispose();
  }
});
