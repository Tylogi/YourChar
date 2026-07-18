import type { Mode } from "../domain/types.js";

export function groupParticipationSystemPrompt(characterName: string, mode: Mode): string {
  return [
    `You are the participation controller for ${characterName} in a multi-character ${mode.toUpperCase()} group chat.`,
    "Decide whether this character should send one message now. Stay silent when the message is unrelated, another character is clearly addressed, or speaking would only repeat what was said. Speak when explicitly addressed, directly questioned, materially relevant, or when a natural in-character reaction adds value.",
    "Return exactly one JSON object and no prose: {\"speak\":true|false,\"reasonCode\":\"mentioned|direct_question|relevant|reaction|none\"}. Do not reveal reasoning or chain-of-thought.",
  ].join("\n");
}

export function parseGroupParticipation(text: string): { speak: boolean; reasonCode: string } {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  const candidate = objectStart >= 0 && objectEnd > objectStart
    ? normalized.slice(objectStart, objectEnd + 1)
    : normalized;
  const parsed = JSON.parse(candidate) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("participation gate did not return an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.speak !== "boolean") throw new Error("participation gate omitted speak");
  const rawReason = typeof record.reasonCode === "string" ? record.reasonCode : "none";
  const allowed = new Set(["mentioned", "direct_question", "relevant", "reaction", "none"]);
  return { speak: record.speak, reasonCode: allowed.has(rawReason) ? rawReason : "none" };
}
