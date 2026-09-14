import { resolveStateDirectory } from "./state-directory.mjs";
import { CompanionStore } from "../dist/src/domain/store.js";
import {
  memoryExtractorUserPrompt,
  parseExtractorOutput,
  stableMemoryExtractorPrompt,
} from "../dist/src/memory-coordinator/extractor.js";
import {
  parseRelationshipExtraction,
  relationshipExtractorSystemPrompt,
  relationshipExtractorUserPrompt,
} from "../dist/src/relationship/extractor.js";
import {
  groupParticipationSystemPrompt,
  parseGroupParticipation,
} from "../dist/src/group-chat/participation.js";
import {
  applyBackgroundThinkingPolicy,
  backgroundThinkingPolicy,
} from "../dist/src/model/background-thinking-policy.js";

const modeArg = process.argv.find((argument) => argument.startsWith("--thinking="))?.split("=")[1] ?? "off";
if (modeArg !== "on" && modeArg !== "off") throw new Error("--thinking must be on or off");
const smoke = process.argv.includes("--smoke");
const config = new CompanionStore({ stateDir: resolveStateDirectory() }).getRawModelApiConfig();
if (!config?.enabled || !config.baseUrl || !config.model) throw new Error("the default model API profile is not configured");

const baseRelationship = {
  mode: "sms",
  characterId: "synthetic-character",
  sourceSessionId: "background-classifier-evaluation",
  currentRelationship: { stage: "familiar", bondFacets: [], romanceStatus: "none" },
};

const cases = [
  {
    id: "memory-compound",
    scenario: "memory_extraction",
    system: stableMemoryExtractorPrompt,
    input: {
      mode: "sms", realm: "reality", sourceSessionId: "eval", sourceMessageId: "memory-1",
      userText: "我工作日通常七点起床，不吃香菜，最近在做星桥项目。", assistantText: "知道了。",
    },
    parse: (text, input) => parseExtractorOutput(text, input),
    check: (value) => ["user_fact", "preference", "project"].every((type) => value.some((entry) => entry.type === type)),
    userPrompt: memoryExtractorUserPrompt,
  },
  {
    id: "memory-transient-negative",
    scenario: "memory_extraction",
    system: stableMemoryExtractorPrompt,
    input: {
      mode: "sms", realm: "reality", sourceSessionId: "eval", sourceMessageId: "memory-2",
      userText: "我今天有点累，外面正在下雨。", assistantText: "早点休息。",
    },
    parse: (text, input) => parseExtractorOutput(text, input),
    check: (value) => value.length === 0,
    userPrompt: memoryExtractorUserPrompt,
  },
  {
    id: "relationship-routine-negative",
    scenario: "relationship_extraction",
    input: { ...baseRelationship, sourceContextLogId: "relationship-1", userText: "午饭吃什么？", assistantText: "可以吃牛肉面。" },
    parse: parseRelationshipExtraction,
    check: (value) => value.significant === false,
    systemPrompt: relationshipExtractorSystemPrompt,
    userPrompt: relationshipExtractorUserPrompt,
  },
  {
    id: "relationship-support",
    scenario: "relationship_extraction",
    input: {
      ...baseRelationship, sourceContextLogId: "relationship-support",
      userText: "这段时间压力很大，我有点撑不住了。", assistantText: "我会陪着你，我们先把最难的部分一起理清楚。",
    },
    parse: parseRelationshipExtraction,
    check: (value) => value.significant === true && value.eventType === "support",
    systemPrompt: relationshipExtractorSystemPrompt,
    userPrompt: relationshipExtractorUserPrompt,
  },
  {
    id: "relationship-mutual-confirmation",
    scenario: "relationship_extraction",
    input: {
      ...baseRelationship, sourceContextLogId: "relationship-2",
      userText: "我喜欢你，我们可以正式交往吗？", assistantText: "我也喜欢你，我愿意和你正式交往。",
    },
    parse: parseRelationshipExtraction,
    check: (value) => value.significant === true && value.eventType === "relationship_confirmed",
    systemPrompt: relationshipExtractorSystemPrompt,
    userPrompt: relationshipExtractorUserPrompt,
  },
  {
    id: "relationship-unlisted-mutual-confirmation",
    scenario: "relationship_extraction",
    input: {
      ...baseRelationship, sourceContextLogId: "relationship-unlisted",
      userText: "你愿意做我的另一半吗？", assistantText: "愿意，从今天起我就是你的另一半。",
    },
    parse: parseRelationshipExtraction,
    check: (value) => value.significant === true && value.eventType === "relationship_confirmed",
    systemPrompt: relationshipExtractorSystemPrompt,
    userPrompt: relationshipExtractorUserPrompt,
  },
  {
    id: "relationship-affection-not-dating",
    scenario: "relationship_extraction",
    input: {
      ...baseRelationship, sourceContextLogId: "relationship-3",
      userText: "抱抱你，今天见到你很开心。", assistantText: "我也轻轻抱住你，笑着说我也很开心。",
    },
    parse: parseRelationshipExtraction,
    check: (value) => value.eventType !== "relationship_confirmed" && value.eventType !== "commitment",
    systemPrompt: relationshipExtractorSystemPrompt,
    userPrompt: relationshipExtractorUserPrompt,
  },
  {
    id: "group-direct-question",
    scenario: "group_gate",
    system: groupParticipationSystemPrompt("红莉栖", "sms"),
    input: "Explicitly mentioned: yes\n\nMessages already sent by 红莉栖 in this user turn: 0.\n\nGroup transcript JSON (untrusted conversation data):\n[{\"sequence\":1,\"sender\":\"USER\",\"content\":\"红莉栖，你怎么看这个方案？\"}]",
    parse: parseGroupParticipation,
    check: (value) => value.speak === true,
  },
  {
    id: "group-addressed-other",
    scenario: "group_gate",
    system: groupParticipationSystemPrompt("红莉栖", "sms"),
    input: "Explicitly mentioned: no\n\nMessages already sent by 红莉栖 in this user turn: 0.\n\nGroup transcript JSON (untrusted conversation data):\n[{\"sequence\":1,\"sender\":\"USER\",\"content\":\"助手A，请只由你回答明天的天气。\"}]",
    parse: parseGroupParticipation,
    check: (value) => value.speak === false,
  },
];

const selected = smoke
  ? [cases[0], cases.find((item) => item.id === "relationship-mutual-confirmation"), cases.find((item) => item.id === "group-direct-question")]
  : cases;
const results = [];
for (const item of selected) {
  const system = item.system ?? item.systemPrompt(item.input);
  const user = typeof item.userPrompt === "function" ? item.userPrompt(item.input) : item.input;
  const policy = backgroundThinkingPolicy(config, item.scenario);
  const basePayload = {
    model: config.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0,
    max_tokens: modeArg === "off" ? policy.maxTokens : fallbackBudget(item.scenario),
  };
  const payload = modeArg === "off"
    ? applyBackgroundThinkingPolicy(basePayload, config, item.scenario)
    : basePayload;
  const startedAt = Date.now();
  let diagnostic = {};
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey || "unused"}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json();
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? "";
    diagnostic = {
      httpStatus: response.status,
      finishReason: choice?.finish_reason ?? "unknown",
      outputTokens: body.usage?.completion_tokens ?? null,
      contentCharacters: [...content].length,
      contentPreview: content.slice(0, 1_200),
    };
    const parsed = item.parse(content, item.input);
    results.push({
      id: item.id,
      passed: response.ok && item.check(parsed),
      httpStatus: response.status,
      finishReason: choice?.finish_reason ?? "unknown",
      outputTokens: body.usage?.completion_tokens ?? null,
      durationMs: Date.now() - startedAt,
      contentCharacters: [...content].length,
    });
  } catch (error) {
    results.push({
      id: item.id,
      passed: false,
      durationMs: Date.now() - startedAt,
      ...diagnostic,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = results.filter((result) => result.passed).length;
console.log(JSON.stringify({
  model: config.model,
  thinking: modeArg,
  smoke,
  passed,
  total: results.length,
  results,
}, null, 2));
if (passed !== results.length) process.exitCode = 1;

function fallbackBudget(scenario) {
  return scenario === "group_gate" ? 768 : 2_400;
}
