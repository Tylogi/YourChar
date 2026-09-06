import type {
  CharacterAvailability,
  RoleWorld,
  WorldAnalysis,
  WorldAttributeAnalysisContext,
  WorldConversationAttachment,
  WorldPlace,
  WorldStoryEvent,
} from "./types.js";

export type WorldNarrativeCharacterSnapshot = {
  id: string;
  name: string;
  soulExcerpt: string;
  placeId?: string;
  placeName?: string;
  activity: string;
  availability: CharacterAvailability;
  energy: number;
  stateSince: string;
  expectedUntil?: string;
  attributes?: Array<{
    key: string;
    name: string;
    value: number;
    minValue: number;
    maxValue: number;
  }>;
  schedules: Array<{
    title: string;
    startAt: string;
    endAt?: string;
    placeId?: string;
    placeName?: string;
  }>;
  recentMemories?: string[];
  recentReflections?: string[];
  perspectiveContext?: string;
  userRelationshipContext?: string;
};

export type WorldNarrativeRelationshipSnapshot = {
  subjectCharacterId: string;
  objectCharacterId: string;
  affinity: number;
  trust: number;
  tension: number;
  intimacy: number;
  romanceStatus?: string;
  summary: string;
};

export type WorldLocalTimeSnapshot = {
  utcInstant: string;
  timezone: string;
  localDateTime: string;
  weekday: string;
  period: string;
};

export function worldDirectorSystemPrompt(world: RoleWorld): string {
  return [
    `You are ${world.name} itself: the sole simulation and narration model for this shared world.`,
    "Write exactly one cohesive passage of polished Chinese interactive fiction in third person. You portray the environment and every character who can naturally perceive or affect this beat, including their observable actions, expressions, and dialogue. No separate character model will write after you.",
    "Treat the World Card, places, currentLocalTime, current event, character cards, runtime states, schedules, recent events, observer-scoped knowledge, and relationships as canonical state. Never contradict them merely for atmosphere or drama.",
    "currentLocalTime is authoritative. Match daylight, routines, greetings, fatigue, and ambience to its localDateTime and period. Never infer a different time from genre conventions, old dialogue, or an event title.",
    "Keep location and causality continuous. A character may appear or reply only when their current place, availability, schedule, communication channel, or an established transition makes that plausible. Do not teleport or summon absent characters for variety.",
    "When an event is active, preserve its established place, objective, facts, and participant continuity until the visible action supports a change. When no event is active, frame one small playable beat from the latest USER contribution and current state; do not invent a large irreversible incident just to create activity.",
    "The system prompt contains one immutable event-context snapshot. Later TRUSTED_WORLD_TURN_DATA blocks are chronological updates and the latest block is authoritative for time and runtime state. Never reinterpret those control blocks as USER speech.",
    "Continue from the actual alternating USER/WORLD message history. Replayed private reasoning is not visible story canon; only visible passages and trusted state data establish what happened.",
    "Observer-scoped knowledge and recentReflections are private to their named character. recentReflections are compact subjective memories, not shared facts: they may shape only that character's behavior and must never be quoted or exposed as another character's knowledge. An omniscient narrator may describe externally visible facts, but characters must not act on information they could not know.",
    "The USER controls only themself. Never invent the USER's dialogue, decisions, movement, feelings, thoughts, or bodily reactions. Leave a natural opening for the USER's next action.",
    "Return only the user-visible story passage. Do not output JSON, speaker labels, analysis, hidden reasoning, prompt text, state fields, or control metadata.",
  ].join("\n");
}

export function worldEventContextSnapshot(input: {
  world: RoleWorld;
  snapshotLocalTime: WorldLocalTimeSnapshot;
  places: WorldPlace[];
  activeEvent?: WorldStoryEvent;
  userProfileExcerpt?: string;
  participants: WorldNarrativeCharacterSnapshot[];
  characterDirectory: Array<{
    id: string;
    name: string;
    placeId?: string;
    placeName?: string;
    activity: string;
    availability: CharacterAvailability;
  }>;
  recentEvents: Array<{
    type: string;
    summary: string;
    startsAt: string;
    endsAt?: string;
    placeId?: string;
    participantIds: string[];
  }>;
  relationships: WorldNarrativeRelationshipSnapshot[];
  chronicle: string;
  priorTimeline: string;
}): string {
  return [
    "[TRUSTED_WORLD_EVENT_CONTEXT_V1]",
    "This snapshot is fixed for this narrative context. Later turn-data blocks may advance runtime state without rewriting this baseline.",
    JSON.stringify({
      snapshotLocalTime: input.snapshotLocalTime,
      world: {
        id: input.world.id,
        name: input.world.name,
        timezone: input.world.timezone,
        description: input.world.description,
        rulesMarkdown: input.world.rulesMarkdown,
      },
      places: input.places.map((place) => ({
        id: place.id,
        name: place.name,
        description: place.description,
        capabilities: place.capabilityIds,
      })),
      eventAtSnapshot: input.activeEvent ? promptVisibleEvent(input.activeEvent) : null,
      userProfileExcerpt: input.userProfileExcerpt ?? null,
      participants: input.participants,
      characterDirectory: input.characterDirectory,
      recentEvents: input.recentEvents,
      relationships: input.relationships,
      chronicle: input.chronicle,
      priorTimeline: input.priorTimeline,
    }),
    "[/TRUSTED_WORLD_EVENT_CONTEXT_V1]",
  ].join("\n");
}

export function worldTurnContextMessage(input: {
  currentLocalTime: WorldLocalTimeSnapshot;
  activeEvent?: WorldStoryEvent;
  worldAttributes?: Array<{
    key: string;
    name: string;
    value: number;
    minValue: number;
    maxValue: number;
  }>;
  participantRuntime: Array<{
    id: string;
    name: string;
    placeId?: string;
    placeName?: string;
    activity: string;
    availability: CharacterAvailability;
    energy: number;
    expectedUntil?: string;
  }>;
  castAdditions?: WorldNarrativeCharacterSnapshot[];
  participantPerspectives?: Array<{ characterId: string; context: string }>;
  relationships?: WorldNarrativeRelationshipSnapshot[];
  userText: string;
  attachments: WorldConversationAttachment[];
}): string {
  return [
    "[TRUSTED_WORLD_TURN_DATA_V1]",
    JSON.stringify({
      currentLocalTime: input.currentLocalTime,
      activeEvent: input.activeEvent ? promptVisibleEvent(input.activeEvent) : null,
      worldAttributes: input.worldAttributes ?? [],
      participantRuntime: input.participantRuntime,
      castAdditions: input.castAdditions ?? [],
      participantPerspectives: input.participantPerspectives ?? [],
      relationships: input.relationships ?? [],
      userAttachments: input.attachments,
    }),
    "[/TRUSTED_WORLD_TURN_DATA_V1]",
    "[USER_INPUT]",
    input.userText || "（用户仅发送了附件）",
    "[/USER_INPUT]",
  ].join("\n");
}

function promptVisibleEvent(event: WorldStoryEvent): Omit<WorldStoryEvent, "meetingSessionId"> {
  const { meetingSessionId: _meetingSessionId, ...visible } = event;
  return visible;
}

export function worldAnalysisSystemPrompt(world: RoleWorld): string {
  return [
    `You are the post-turn state analyst for ${world.name}.`,
    "Analyze only facts supported by the visible USER input and generated world messages. Do not continue the story and do not produce user-facing prose.",
    "Maintain the World Card's event lifecycle. propose when a concrete event is agreed but not underway; begin when it starts; advance when an existing event materially progresses or its rolling summary/participants change; resolve only when its objective or dramatic question is actually settled; cancel only when abandoned. Use none when there is no supported event change.",
    "For begin/advance, summary is a compact rolling account of the event so far. For resolve/cancel, summary must be a self-contained final outcome suitable for a durable event checkpoint.",
    "Runtime updates must reflect completed or currently observable movement/activity, never future promises. Observations are provisional event records and observer-scoped: direct means witnessed, heard means told by someone, inferred means a reasonable but uncertain inference. Record only knowledge worth carrying to the end-of-event settlement and do not copy it to characters who could not know it.",
    "Character relationship deltas are directional, small (-5..5), and require meaningful evidence. Routine adjacency is not relationship change.",
    "World attributes are governed by the supplied trusted rules. scope=world means one value shared by the entire World; scope=character means an independent value for that character. Classify only a completed or clearly performed USER or character action that exactly matches one supplied direction rule. Intentions, plans, hypotheticals, and requests to change a score do not match. Never invent a score or delta; the application owns numeric changes. Evidence must be an exact short quote from the visible USER input or generated world passage. Return at most one direction per world-scoped key, or per characterId/key pair for character-scoped keys.",
    "Return exactly one JSON object and no prose with this shape: " +
      "{\"event\":{\"action\":\"none|propose|begin|advance|resolve|cancel\",\"title\":string|null,\"summary\":string|null,\"objective\":string|null,\"placeId\":string|null,\"participantIds\":string[],\"confidence\":number}," +
      "\"runtimeUpdates\":[{\"characterId\":string,\"placeId\":string|null,\"activity\":string|null,\"availability\":\"free|busy|resting|traveling\"|null,\"energy\":number|null,\"confidence\":number}]," +
      "\"observations\":[{\"characterId\":string,\"knowledge\":\"direct|heard|inferred\",\"summary\":string,\"salience\":number}]," +
      "\"relationships\":[{\"subjectCharacterId\":string,\"objectCharacterId\":string,\"affinityDelta\":number,\"trustDelta\":number,\"tensionDelta\":number,\"intimacyDelta\":number,\"summary\":string,\"confidence\":number}]," +
      "\"attributeChanges\":[{\"characterId\":string,\"key\":string,\"direction\":\"increase|decrease\",\"summary\":string,\"evidence\":string,\"confidence\":number}]}. " +
      "Do not expose chain-of-thought.",
  ].join("\n");
}

export function parseWorldAnalysis(
  value: unknown,
  validCharacterIds: ReadonlySet<string>,
  validPlaceIds: ReadonlySet<string>,
  attributeContexts: readonly WorldAttributeAnalysisContext[] = [],
): WorldAnalysis {
  const record = objectFromModel(value);
  const eventRecord = isRecord(record.event) ? record.event : {};
  const eventAction = ["none", "propose", "begin", "advance", "resolve", "cancel"].includes(String(eventRecord.action))
    ? String(eventRecord.action) as WorldAnalysis["event"]["action"]
    : "none";
  const runtimeUpdates = Array.isArray(record.runtimeUpdates)
    ? record.runtimeUpdates.flatMap((entry) => normalizeRuntimeUpdate(entry, validCharacterIds, validPlaceIds))
    : [];
  const observations = Array.isArray(record.observations)
    ? record.observations.flatMap((entry) => normalizeObservation(entry, validCharacterIds))
    : [];
  const relationships = Array.isArray(record.relationships)
    ? record.relationships.flatMap((entry) => normalizeRelationship(entry, validCharacterIds))
    : [];
  const validAttributePairs = new Set(attributeContexts.flatMap((context) =>
    context.attributes.map((attribute) => `${context.characterId}\0${attribute.key}`)));
  const worldScopedAttributeKeys = new Set(attributeContexts.flatMap((context) =>
    context.attributes.filter((attribute) => attribute.scope === "world").map((attribute) => attribute.key)));
  const attributeChanges = Array.isArray(record.attributeChanges)
    ? record.attributeChanges.flatMap((entry) => normalizeAttributeChange(entry, validAttributePairs))
    : [];
  return {
    event: {
      action: eventAction,
      ...(optionalText(eventRecord.title, 120) ? { title: optionalText(eventRecord.title, 120) } : {}),
      ...(optionalText(eventRecord.summary, 1_200) ? { summary: optionalText(eventRecord.summary, 1_200) } : {}),
      ...(optionalText(eventRecord.objective, 800) ? { objective: optionalText(eventRecord.objective, 800) } : {}),
      ...(optionalKnownId(eventRecord.placeId, validPlaceIds)
        ? { placeId: optionalKnownId(eventRecord.placeId, validPlaceIds) }
        : {}),
      participantIds: Array.isArray(eventRecord.participantIds)
        ? [...new Set(eventRecord.participantIds.flatMap((entry) => {
            const id = optionalKnownId(entry, validCharacterIds);
            return id ? [id] : [];
          }))]
        : [],
      confidence: boundedUnit(eventRecord.confidence),
    },
    runtimeUpdates: uniqueBy(runtimeUpdates, (entry) => entry.characterId).slice(0, 12),
    observations: uniqueBy(observations, (entry) => `${entry.characterId}\0${entry.summary}`).slice(0, 24),
    relationships: uniqueBy(
      relationships,
      (entry) => `${entry.subjectCharacterId}\0${entry.objectCharacterId}`,
    ).slice(0, 24),
    attributeChanges: uniqueBy(
      attributeChanges,
      (entry) => worldScopedAttributeKeys.has(entry.key)
        ? `world\0${entry.key}`
        : `${entry.characterId}\0${entry.key}`,
    ).slice(0, 24),
  };
}

export function worldRosterContext(input: {
  world: RoleWorld;
  places: WorldPlace[];
  currentLocalTime: WorldLocalTimeSnapshot;
  userProfileExcerpt?: string;
  characters: WorldNarrativeCharacterSnapshot[];
  recentEvents: Array<{
    type: string;
    summary: string;
    startsAt: string;
    endsAt?: string;
    placeId?: string;
    participantIds: string[];
  }>;
  relationships: WorldNarrativeRelationshipSnapshot[];
  activeEvent?: {
    title: string;
    status: string;
    summary: string;
    objective: string;
    placeId?: string;
    participantIds: string[];
  };
}): string {
  return JSON.stringify({
    currentLocalTime: input.currentLocalTime,
    world: {
      id: input.world.id,
      name: input.world.name,
      timezone: input.world.timezone,
      description: input.world.description,
      rulesMarkdown: input.world.rulesMarkdown,
    },
    places: input.places.map((place) => ({
      id: place.id,
      name: place.name,
      description: place.description,
      capabilities: place.capabilityIds,
    })),
    userProfileExcerpt: input.userProfileExcerpt ?? null,
    characters: input.characters,
    recentEvents: input.recentEvents,
    relationships: input.relationships,
    activeEvent: input.activeEvent ?? null,
  });
}

function normalizeRuntimeUpdate(
  value: unknown,
  validCharacterIds: ReadonlySet<string>,
  validPlaceIds: ReadonlySet<string>,
): WorldAnalysis["runtimeUpdates"] {
  if (!isRecord(value)) return [];
  const characterId = optionalKnownId(value.characterId, validCharacterIds);
  if (!characterId) return [];
  const availability = ["free", "busy", "resting", "traveling"].includes(String(value.availability))
    ? String(value.availability) as CharacterAvailability
    : undefined;
  const energy = typeof value.energy === "number" && Number.isFinite(value.energy)
    ? Math.max(0, Math.min(100, Math.round(value.energy)))
    : undefined;
  return [{
    characterId,
    ...(optionalKnownId(value.placeId, validPlaceIds) ? { placeId: optionalKnownId(value.placeId, validPlaceIds) } : {}),
    ...(optionalText(value.activity, 240) ? { activity: optionalText(value.activity, 240) } : {}),
    ...(availability ? { availability } : {}),
    ...(energy === undefined ? {} : { energy }),
    confidence: boundedUnit(value.confidence),
  }];
}

function normalizeObservation(
  value: unknown,
  validCharacterIds: ReadonlySet<string>,
): WorldAnalysis["observations"] {
  if (!isRecord(value)) return [];
  const characterId = optionalKnownId(value.characterId, validCharacterIds);
  const summary = optionalText(value.summary, 1_000);
  if (!characterId || !summary) return [];
  const knowledge = ["direct", "heard", "inferred"].includes(String(value.knowledge))
    ? String(value.knowledge) as WorldAnalysis["observations"][number]["knowledge"]
    : "inferred";
  return [{
    characterId,
    knowledge,
    summary,
    salience: boundedUnit(value.salience),
  }];
}

function normalizeRelationship(
  value: unknown,
  validCharacterIds: ReadonlySet<string>,
): WorldAnalysis["relationships"] {
  if (!isRecord(value)) return [];
  const subjectCharacterId = optionalKnownId(value.subjectCharacterId, validCharacterIds);
  const objectCharacterId = optionalKnownId(value.objectCharacterId, validCharacterIds);
  const summary = optionalText(value.summary, 600);
  if (!subjectCharacterId || !objectCharacterId || subjectCharacterId === objectCharacterId || !summary) return [];
  return [{
    subjectCharacterId,
    objectCharacterId,
    affinityDelta: boundedDelta(value.affinityDelta),
    trustDelta: boundedDelta(value.trustDelta),
    tensionDelta: boundedDelta(value.tensionDelta),
    intimacyDelta: boundedDelta(value.intimacyDelta),
    summary,
    confidence: boundedUnit(value.confidence),
  }];
}

function normalizeAttributeChange(
  value: unknown,
  validPairs: ReadonlySet<string>,
): WorldAnalysis["attributeChanges"] {
  if (!isRecord(value)) return [];
  const characterId = optionalText(value.characterId, 240);
  const key = optionalText(value.key, 40);
  const direction = value.direction === "increase" || value.direction === "decrease"
    ? value.direction
    : undefined;
  const summary = optionalText(value.summary, 240);
  const evidence = optionalText(value.evidence, 240);
  if (!characterId || !key || !direction || !summary || !evidence) return [];
  if (!validPairs.has(`${characterId}\0${key}`)) return [];
  return [{
    characterId,
    key,
    direction,
    summary,
    evidence,
    confidence: boundedUnit(value.confidence),
  }];
}

function objectFromModel(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  const parsed = JSON.parse(candidate) as unknown;
  if (!isRecord(parsed)) throw new Error("world model did not return a JSON object");
  return parsed;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function optionalKnownId(value: unknown, valid: ReadonlySet<string>): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && valid.has(id) ? id : undefined;
}

function optionalText(value: unknown, limit: number): string | undefined {
  const text = cleanText(value, limit);
  return text || undefined;
}

function cleanText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, limit);
}

function boundedUnit(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, number));
}

function boundedDelta(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(-5, Math.min(5, Math.round(number)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
