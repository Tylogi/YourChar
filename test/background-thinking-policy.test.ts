import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBackgroundThinkingPolicy,
  backgroundThinkingPolicy,
  interactiveThinkingTemplateKwargs,
  requiresInteractiveThinking,
} from "../src/model/background-thinking-policy.js";
import { applyConfiguredReasoningEffort } from "../src/model/reasoning-effort.js";

test("MLX interactive calls explicitly keep thinking enabled across turns", () => {
  assert.deepEqual(interactiveThinkingTemplateKwargs({ model: "gemma-4-26B-A4B-MLX-9bit" }), {
    enable_thinking: true,
    preserve_thinking: true,
  });
  assert.equal(interactiveThinkingTemplateKwargs({ model: "remote-reasoning-model" }), undefined);
  assert.equal(requiresInteractiveThinking({ model: "gemma-4-26B-A4B-MLX-9bit" }), true);
  assert.equal(requiresInteractiveThinking({ model: "remote-reasoning-model" }), false);

  const disabled = { model: "gemma-4-26B-A4B-MLX-9bit", reasoningEffort: "none" as const };
  assert.deepEqual(interactiveThinkingTemplateKwargs(disabled), {
    enable_thinking: false,
    preserve_thinking: true,
  });
  assert.equal(requiresInteractiveThinking(disabled), false);

  const strong = { model: "gemma-4-26B-A4B-MLX-9bit", reasoningEffort: "xhigh" as const };
  assert.deepEqual(interactiveThinkingTemplateKwargs(strong), {
    enable_thinking: true,
    preserve_thinking: true,
  });
  assert.equal(requiresInteractiveThinking(strong), true);
});

test("configured reasoning effort uses the OpenAI-compatible wire field and automatic mode omits it", () => {
  const original = { model: "reasoning-model", messages: [] };
  assert.equal(applyConfiguredReasoningEffort(original, { model: original.model }), original);
  for (const reasoningEffort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
    assert.deepEqual(applyConfiguredReasoningEffort(original, { model: original.model, reasoningEffort }), {
      ...original,
      reasoning_effort: reasoningEffort,
    });
  }
  assert.deepEqual(applyConfiguredReasoningEffort(
    { ...original, reasoning_effort: "high" },
    { model: "local-MLX-model", reasoningEffort: "none" },
  ), original);
});

test("MLX deterministic background calls disable thinking and use compact budgets", () => {
  const config = { model: "gemma-4-26B-A4B-MLX-9bit", reasoningEffort: "xhigh" as const };
  assert.equal(backgroundThinkingPolicy(config, "group_gate").maxTokens, 256);
  assert.equal(backgroundThinkingPolicy(config, "memory_extraction").maxTokens, 1_024);
  assert.equal(backgroundThinkingPolicy(config, "relationship_extraction").maxTokens, 1_024);
  assert.equal(backgroundThinkingPolicy(config, "post_turn_analysis").maxTokens, 1_024);
  assert.equal(backgroundThinkingPolicy(config, "quality_judge").maxTokens, 1_200);

  const payload = applyBackgroundThinkingPolicy({
    model: config.model,
    max_tokens: 9_999,
    reasoning_effort: "xhigh",
    chat_template_kwargs: { custom_flag: true },
  }, config, "group_gate") as Record<string, unknown>;
  assert.equal(payload.max_tokens, 256);
  assert.deepEqual(payload.chat_template_kwargs, {
    custom_flag: true,
    enable_thinking: false,
    preserve_thinking: true,
  });
  assert.equal("reasoning_effort" in payload, false);
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
  assert.equal(backgroundThinkingPolicy(config, "post_turn_analysis").maxTokens, 2_400);
  assert.equal(backgroundThinkingPolicy(config, "quality_judge").maxTokens, 2_800);

  const payload = applyBackgroundThinkingPolicy({ model: config.model }, config, "memory_extraction") as Record<string, unknown>;
  assert.equal(payload.max_tokens, 2_400);
  assert.equal("chat_template_kwargs" in payload, false);
});

test("non-object provider payloads pass through unchanged", () => {
  assert.equal(applyBackgroundThinkingPolicy(null, { model: "local-MLX" }, "group_gate"), null);
  assert.equal(applyBackgroundThinkingPolicy("payload", { model: "local-MLX" }, "group_gate"), "payload");
});
