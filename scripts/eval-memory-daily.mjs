import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDirectory } from "./state-directory.mjs";
import {
  memoryExtractorUserPrompt,
  parseExtractorOutput,
  stableMemoryExtractorPrompt,
} from "../dist/src/memory-coordinator/extractor.js";
import {
  applyBackgroundThinkingPolicy,
  backgroundThinkingPolicy,
} from "../dist/src/model/background-thinking-policy.js";

const configPath = join(resolveStateDirectory(), "model-api.json");
const config = activeConfig(JSON.parse(readFileSync(configPath, "utf8")));
if (!config?.enabled || !config.baseUrl || !config.model) {
  throw new Error("the default model API profile is not configured");
}

const samples = [
  {
    id: "routine-preference-project",
    text: "我平时工作日早上七点起床，不吃香菜，最近在做一个叫星桥的长期项目。以后回复我时尽量先说结论。",
    expectedTypes: ["user_fact", "preference", "project"],
  },
  {
    id: "person",
    text: "我妹妹叫小雨，她在上海工作。",
    expectedTypes: ["person"],
  },
  {
    id: "goal",
    text: "我希望今年年底前把论文投出去。",
    expectedTypes: ["goal"],
  },
  {
    id: "transient-negative",
    text: "我今天有点累，窗外正在下雨。",
    expectedTypes: [],
  },
];

const results = [];
const policy = backgroundThinkingPolicy(config, "memory_extraction");
for (const [index, sample] of samples.entries()) {
  const input = {
    mode: "sms",
    realm: "reality",
    sourceSessionId: "daily-memory-model-evaluation",
    sourceMessageId: `daily-memory-${index + 1}`,
    userText: sample.text,
    assistantText: "知道了。",
  };
  let diagnostic = {};
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey || "unused"}`,
      },
      body: JSON.stringify(applyBackgroundThinkingPolicy({
        model: config.model,
        messages: [
          { role: "system", content: stableMemoryExtractorPrompt },
          { role: "user", content: memoryExtractorUserPrompt(input) },
        ],
        temperature: 0,
        max_tokens: policy.maxTokens,
      }, config, "memory_extraction")),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? "";
    diagnostic = {
      httpStatus: response.status,
      finishReason: choice?.finish_reason ?? "unknown",
      outputTokens: body.usage?.completion_tokens ?? null,
      contentCharacters: [...content].length,
      contentPreview: content.slice(0, 800),
    };
    const candidates = parseExtractorOutput(content, input);
    const types = [...new Set(candidates.map((candidate) => candidate.type))];
    const exactEvidence = candidates.every((candidate) => {
      const evidence = candidate.evidence?.user?.trim();
      return Boolean(evidence && sample.text.includes(evidence));
    });
    const confident = candidates.every((candidate) => (candidate.confidence ?? 0) >= 0.88);
    const expected = sample.expectedTypes.every((type) => types.includes(type));
    const negativeClean = sample.expectedTypes.length > 0 || candidates.length === 0;
    results.push({
      id: sample.id,
      passed: response.ok && exactEvidence && confident && expected && negativeClean,
      httpStatus: response.status,
      finishReason: choice?.finish_reason ?? "unknown",
      outputTokens: body.usage?.completion_tokens ?? null,
      candidateCount: candidates.length,
      types,
      exactEvidence,
      confident,
      expectedTypesPresent: expected,
      negativeClean,
    });
  } catch (error) {
    results.push({
      id: sample.id,
      passed: false,
      ...diagnostic,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = results.filter((result) => result.passed).length;
console.log(JSON.stringify({
  model: config.model,
  thinkingPolicy: policy,
  passed,
  total: results.length,
  passRate: passed / results.length,
  results,
}, null, 2));
if (passed !== results.length) process.exitCode = 1;

function activeConfig(raw) {
  if (raw?.version === 2 && Array.isArray(raw.profiles)) {
    return raw.profiles.find((profile) => profile.id === raw.defaultProfileId) ?? raw.profiles[0];
  }
  return raw;
}
