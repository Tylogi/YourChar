import type { Clock } from "../app/clock.js";
import { normalizeMemoryContent, type RpRepository } from "../rp/repository.js";
import type { RpMemory } from "../rp/types.js";
import type { MemoryVaultService } from "../memory-vault/service.js";
import { estimateTokens, roundMetric } from "./tokens.js";
import { memoryContextVersion } from "./memory-version.js";
import type {
  MemoryRetrievalCandidate,
  MemoryRetrievalPlan,
  RetrievalScoreBreakdown,
} from "./types.js";

const stopBigrams = new Set([
  "用户", "我的", "我是", "什么", "哪里", "记得", "请问", "这个", "那个", "是否", "可以", "关于",
]);

export class MemoryRetriever {
  constructor(
    private readonly repository: RpRepository,
    private readonly clock: Clock,
    private readonly personDirectory?: Pick<MemoryVaultService, "contextualizeRealityMemories">,
  ) {}

  retrieve(input: {
    query: string;
    realm: "reality" | "roleplay";
    characterId?: string;
    viewerCharacterId?: string;
    bootstrap?: boolean;
    limit?: number;
  }): MemoryRetrievalPlan {
    if (input.realm === "roleplay" && !input.characterId) {
      return emptyPlan(input);
    }
    const query = input.query.trim();
    const normalizedQuery = normalizeMemoryContent(normalizeRetrievalIntent(query));
    const stored = this.repository.searchMemories({
      realm: input.realm,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      validity: "active",
      confirmedOnly: true,
      limit: Math.min(Math.max(input.limit ?? 100, 1), 100),
    }).filter((memory) => input.realm === "reality"
      ? memory.characterId === undefined
      : memory.characterId === input.characterId);
    const strict = input.realm === "reality" && this.personDirectory
      ? this.personDirectory.contextualizeRealityMemories(stored, input.viewerCharacterId, query)
      : stored;
    const ftsRanks = query
      ? this.repository.rankMemoryFts({
          query,
          realm: input.realm,
          ...(input.characterId ? { characterId: input.characterId } : {}),
          limit: input.limit ?? 100,
        })
      : new Map<string, number>();
    const candidates = strict.map((memory) => this.score(memory, query, normalizedQuery, ftsRanks.get(memory.id), Boolean(input.bootstrap)))
      .sort((left, right) => {
        const leftEligible = left.exclusionReason ? 0 : 1;
        const rightEligible = right.exclusionReason ? 0 : 1;
        return rightEligible - leftEligible || right.score - left.score || left.memoryId.localeCompare(right.memoryId);
      });
    return {
      realm: input.realm,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      query,
      normalizedQuery,
      bootstrapRequested: Boolean(input.bootstrap),
      candidateCount: strict.length,
      selectedMemoryIds: [],
      candidates,
    };
  }

  private score(
    memory: RpMemory,
    query: string,
    normalizedQuery: string,
    ftsRank: number | undefined,
    allowBootstrap: boolean,
  ): MemoryRetrievalCandidate {
    const key = normalizeMemoryContent(memory.key ?? "");
    const normalizedTags = memory.tags.map(normalizeMemoryContent).filter(Boolean);
    const exactKey = Boolean(key && normalizedQuery && (normalizedQuery === key || normalizedQuery.includes(key)));
    const exactTag = Boolean(normalizedQuery && normalizedTags.some((tag) =>
      normalizedQuery === tag || normalizedQuery.includes(tag)
    ));
    const exactContent = Boolean(normalizedQuery && (
      memory.normalizedContent.includes(normalizedQuery) || normalizedQuery.includes(memory.normalizedContent)
    ));
    const lexical = lexicalSimilarity(query, memory.content);
    const fts = ftsRank === undefined ? 0 : Math.min(1, 1 / (1 + Math.abs(ftsRank)));
    const relevance = Math.max(
      exactContent ? 1 : 0,
      exactKey ? 0.95 : 0,
      exactTag ? 0.9 : 0,
      fts ? 0.72 + fts * 0.08 : 0,
      lexical * 0.8,
    );
    const recency = recencyScore(memory.updatedAt, this.clock.now());
    const breakdown: RetrievalScoreBreakdown = {
      relevance: roundMetric(relevance),
      salience: roundMetric(memory.salience),
      recency: roundMetric(recency),
      confidence: roundMetric(memory.confidence),
      exactKey,
      exactTag,
      exactContent,
      fts: roundMetric(fts),
      lexical: roundMetric(lexical),
    };
    const score = roundMetric(
      relevance * 0.6 + memory.salience * 0.18 + recency * 0.1 + memory.confidence * 0.12,
    );
    const relevant = relevance >= 0.24;
    const core = memory.salience >= 0.85 || normalizedTags.includes("core");
    const bootstrap = !relevant && allowBootstrap && core;
    const reason = [
      exactKey && "exact_key",
      exactTag && "exact_tag",
      exactContent && "exact_content",
      fts > 0 && "fts_bm25",
      lexical >= 0.3 && "lexical_overlap",
      bootstrap && "session_bootstrap_core",
    ].filter(Boolean).join("+") || "no_relevance";
    return {
      memoryId: memory.id,
      realm: memory.realm as "reality" | "roleplay",
      ...(memory.characterId ? { characterId: memory.characterId } : {}),
      type: memory.type,
      key: memory.key,
      tags: [...memory.tags],
      content: memory.content,
      updatedAt: memory.updatedAt,
      version: memoryContextVersion(memory),
      lastUsedAt: memory.lastUsedAt,
      estimatedTokens: estimateTokens(`- [${memory.type}] ${memory.content}`),
      score,
      breakdown,
      reason,
      selected: false,
      ...(relevant || bootstrap ? {} : { exclusionReason: "no_relevance" }),
      bootstrap,
    };
  }
}

function emptyPlan(input: { query: string; realm: "reality" | "roleplay"; characterId?: string; bootstrap?: boolean }): MemoryRetrievalPlan {
  return {
    realm: input.realm,
    ...(input.characterId ? { characterId: input.characterId } : {}),
    query: input.query.trim(),
    normalizedQuery: normalizeMemoryContent(normalizeRetrievalIntent(input.query)),
    bootstrapRequested: Boolean(input.bootstrap),
    candidateCount: 0,
    selectedMemoryIds: [],
    candidates: [],
  };
}

function lexicalSimilarity(query: string, content: string): number {
  const queryTerms = lexicalTerms(normalizeRetrievalIntent(query));
  const contentTerms = lexicalTerms(content);
  if (!queryTerms.size || !contentTerms.size) return 0;
  let overlap = 0;
  for (const term of queryTerms) if (contentTerms.has(term)) overlap += 1;
  return overlap / Math.max(1, Math.min(queryTerms.size, contentTerms.size));
}

function normalizeRetrievalIntent(value: string): string {
  const normalized = value.toLocaleLowerCase()
    .replace(/[，。！？?!；;：:]/g, " ")
    .replace(/(?:请问)?(?:你)?还?记得/g, " ")
    .replace(/(?:我们|我和你)的?/g, " ")
    .replace(/(?:吗|么|呢)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || value;
}

function lexicalTerms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_]{2,}/g) ?? []);
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...sequence];
    for (let index = 0; index < characters.length - 1; index += 1) {
      const term = `${characters[index]}${characters[index + 1]}`;
      if (!stopBigrams.has(term)) terms.add(term);
    }
  }
  return terms;
}

function recencyScore(updatedAt: string, now: Date): number {
  const age = Math.max(0, now.getTime() - new Date(updatedAt).getTime());
  const days = age / 86_400_000;
  return 1 / (1 + days / 30);
}
