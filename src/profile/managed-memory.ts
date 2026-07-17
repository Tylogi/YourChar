import { USER_PROFILE_MAX_CHARACTERS } from "./types.js";
import type { RpMemory } from "../rp/types.js";
import { UserProfileValidationError } from "./service.js";

export const managedRealityStart = "<!-- rp-agent:managed-reality:start -->";
export const managedRealityEnd = "<!-- rp-agent:managed-reality:end -->";

const managedBlockPattern = new RegExp(
  `\\n*${escapeRegExp(managedRealityStart)}[\\s\\S]*?${escapeRegExp(managedRealityEnd)}\\n*`,
  "g",
);
const managedBlockOnlyPattern = new RegExp(
  `${escapeRegExp(managedRealityStart)}[\\s\\S]*?${escapeRegExp(managedRealityEnd)}\\n?`,
);

export function projectRealityMemoriesIntoProfile(markdown: string, memories: RpMemory[]): string {
  const manual = profileManualSection(markdown);
  const manualCharacters = [...manual].length;
  if (manualCharacters > USER_PROFILE_MAX_CHARACTERS) {
    throw new UserProfileValidationError(
      `user profile manual section must not exceed ${USER_PROFILE_MAX_CHARACTERS} characters (received ${manualCharacters})`,
    );
  }
  if (!memories.length) return manual;
  const header = `${managedRealityStart}\n## 已确认长期信息\n`;
  const footer = `${managedRealityEnd}\n`;
  let managed = "";
  const sorted = [...memories].sort(
    (left, right) => right.salience - left.salience || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
  for (const memory of sorted) {
    const content = escapeManagedMarkers(memory.content.replace(/\s+/g, " ").trim());
    const line = `- [${memory.type}] ${content}\n`;
    const candidate = `${manual}${profileSeparator(manual)}${header}${managed}${line}${footer}`;
    if ([...candidate].length > USER_PROFILE_MAX_CHARACTERS) continue;
    managed += line;
  }
  if (!managed) return manual;
  return `${manual}${profileSeparator(manual)}${header}${managed}${footer}`;
}

export function profileManualSection(markdown: string): string {
  if (!markdown.includes(managedRealityStart)) return markdown;
  return markdown.replace(managedBlockPattern, "");
}

export function replaceProfileManualSection(currentMarkdown: string, replacementMarkdown: string): string {
  const manual = profileManualSection(replacementMarkdown);
  const managed = currentMarkdown.match(managedBlockOnlyPattern)?.[0];
  const merged = managed ? `${manual}${profileSeparator(manual)}${managed}` : manual;
  const characters = [...merged].length;
  if (characters > USER_PROFILE_MAX_CHARACTERS) {
    throw new UserProfileValidationError(
      `user profile must not exceed ${USER_PROFILE_MAX_CHARACTERS} characters (received ${characters})`,
    );
  }
  return merged;
}

function profileSeparator(markdown: string): string {
  return markdown.endsWith("\n") ? "\n" : "\n\n";
}

function escapeManagedMarkers(content: string): string {
  return content
    .replaceAll(managedRealityStart, "&lt;!-- rp-agent:managed-reality:start --&gt;")
    .replaceAll(managedRealityEnd, "&lt;!-- rp-agent:managed-reality:end --&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
