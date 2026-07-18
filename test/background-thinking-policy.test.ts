import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBackgroundThinkingPolicy,
  backgroundThinkingPolicy,
  interactiveThinkingTemplateKwargs,
  requiresInteractiveThinking,
} from "../src/model/background-thinking-policy.js";

test("MLX interactive calls explicitly keep thinking enabled across turns", () => {
  assert.deepEqual(interactiveThinkingTemplateKwargs({ model: "gemma-4-26B-A4B-MLX-9bit" }), {
    enable_thinking: true,
    preserve_thinking: true,
  });
  assert.equal(interactiveThinkingTemplateKwargs({ model: "remote-reasoning-model" }), undefined);
  assert.equal(requiresInteractiveThinking({ model: "gemma-4-26B-A4B-MLX-9bit" }), true);
  assert.equal(requiresInteractiveThinking({ model: "remote-reasoning-model" }), false);
});

test("MLX deterministic background calls disable thinking and use compact budgets", () => {
  const config = { model: "gemma-4-26B-A4B-MLX-9bit" };
  assert.equal(backgroundThinkingPolicy(config, "group_gate").maxTokens, 256);
  assert.equal(backgroundThinkingPolicy(config, "memory_extraction").maxTokens, 1_024);
  assert.equal(backgroundThinkingPolicy(config, "relationship_extraction").maxTokens, 1_024);

  const payload = applyBackgroundThinkingPolicy({
    model: config.model,
    max_tokens: 9_999,
    chat_template_kwargs: { custom_flag: true },
  }, config, "group_gate") as Record<string, unknown>;
  assert.equal(payload.max_tokens, 256);
  assert.deepEqual(payload.chat_template_kwargs, {
    custom_flag: true,
    enable_thinking: false,
    preserve_thinking: true,
  });
});

test("unknown compatible providers keep fallback budgets and receive no vendor fields", () => {
  const config = { model: "remote-reasoning-model" };
  assert.deepEqual(backgroundThinkingPolicy(config, "group_gate"), {
    requested: "off",
    enforced: false,
    mechanism: "unsupported",
    maxTokens: 768,
  });
  assert.equal(backgroundThinkingPolicy(config, "memory_extraction").maxTokens, 2_400);
  assert.equal(backgroundThinkingPolicy(config, "relationship_extraction").maxTokens, 2_400);

  const payload = applyBackgroundThinkingPolicy({ model: config.model }, config, "memory_extraction") as Record<string, unknown>;
  assert.equal(payload.max_tokens, 2_400);
  assert.equal("chat_template_kwargs" in payload, false);
});

test("non-object provider payloads pass through unchanged", () => {
  assert.equal(applyBackgroundThinkingPolicy(null, { model: "local-MLX" }, "group_gate"), null);
  assert.equal(applyBackgroundThinkingPolicy("payload", { model: "local-MLX" }, "group_gate"), "payload");
});
