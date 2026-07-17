const internalAnalysisStarts = [
  "the user",
  "we need",
  "let's",
  "let’s",
  "i need",
  "i should",
  "analysis:",
  "analysis：",
  "task:",
  "task：",
  "wait,",
  "let me check",
];

const explicitReasoningTitles = [
  "thinking process",
  "thinking",
  "reasoning",
  "chain of thought",
];

export type AssistantOutputClassification = "pending" | "safe" | "blocked";

export function classifyAssistantOutput(text: string): AssistantOutputClassification {
  const visible = stripCompletedThinkingBlocks(text).trimStart();
  if (!visible) return "pending";
  if (/^<(?:think|thinking)(?:>|\s|$)/i.test(visible)) return "pending";

  const titleClassification = classifyExplicitReasoningTitle(visible);
  if (titleClassification) return titleClassification;

  const prefix = visible.slice(0, 32).toLocaleLowerCase("en-US");
  if (internalAnalysisStarts.some((candidate) => prefix.startsWith(candidate))) {
    return "blocked";
  }
  if (internalAnalysisStarts.some((candidate) => candidate.startsWith(prefix))) {
    return "pending";
  }
  return "safe";
}

function classifyExplicitReasoningTitle(
  visible: string,
): Extract<AssistantOutputClassification, "pending" | "blocked"> | undefined {
  const firstLine = visible.slice(0, 160).split(/\r?\n/, 1)[0];
  const heading = /^#{1,6}[ \t]+/.test(firstLine);
  const normalized = firstLine
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(/\*\*|__/g, "")
    .trim();
  const lower = normalized.toLocaleLowerCase("en-US");
  const titledColon = explicitReasoningTitles.some((title) =>
    lower === `${title}:` || lower === `${title}：` ||
    lower.startsWith(`${title}:`) || lower.startsWith(`${title}：`)
  );
  if (titledColon || (heading && explicitReasoningTitles.includes(lower))) {
    return "blocked";
  }

  const possible = lower.length === 0 || explicitReasoningTitles.some((title) =>
    title.startsWith(lower) || `${title}:`.startsWith(lower) || `${title}：`.startsWith(lower)
  );
  return possible ? "pending" : undefined;
}

export function containsInternalAnalysis(text: string): boolean {
  return classifyAssistantOutput(text) === "blocked";
}

function stripCompletedThinkingBlocks(text: string): string {
  return text
    .replace(/^\s*<think>[\s\S]*?<\/think>/i, "")
    .replace(/^\s*<thinking>[\s\S]*?<\/thinking>/i, "");
}
