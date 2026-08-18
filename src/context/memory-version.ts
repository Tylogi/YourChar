import type { RpMemory } from "../rp/types.js";
import { stableHash } from "./tokens.js";

export function memoryContextVersion(memory: RpMemory): string {
  return stableHash({
    id: memory.id,
    conversationSpace: memory.conversationSpace,
    secretOwnerCharacterId: memory.secretOwnerCharacterId ?? null,
    realm: memory.realm,
    scope: memory.scope,
    characterId: memory.characterId ?? null,
    type: memory.type,
    key: memory.key ?? null,
    content: memory.content,
    salience: memory.salience,
    confidence: memory.confidence,
    validity: memory.validity,
    confirmed: memory.confirmed,
    tags: memory.tags,
    updatedAt: memory.updatedAt,
  });
}
