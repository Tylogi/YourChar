import * as z from "zod/v4";

const id = z.string().trim().min(1).max(120);
const name = z.string().trim().min(1).max(80);
const description = z.string().max(1200);
const timezone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "无效的时区");
const worldFields = z.object({ name, description: description.optional(), rulesMarkdown: z.string().max(6000).optional(), timezone: timezone.optional() }).strict();
const characterFields = z.object({ name, soulMarkdown: z.string().trim().min(1).max(8000) }).strict();
const placeFields = z.object({ name, description: z.string().max(800).optional(), capabilityIds: z.array(z.enum([
  "rest", "work", "study", "socialize", "eat", "shop", "exercise", "travel", "create", "observe", "communicate",
])).max(11).optional() }).strict();
const nonEmpty = (value: object) => Object.keys(value).length > 0;

// Deliberately excludes deletion, memories, credentials, model/permission bindings,
// user calendars, shell execution and installation/deployment of MCP servers.
export const creatorOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_world"), input: worldFields }).strict(),
  z.object({ kind: z.literal("update_world"), worldId: id, patch: worldFields.partial().refine(nonEmpty) }).strict(),
  z.object({ kind: z.literal("create_character"), input: characterFields }).strict(),
  z.object({ kind: z.literal("update_character"), characterId: id, patch: characterFields.partial().refine(nonEmpty) }).strict(),
  z.object({ kind: z.literal("create_place"), worldId: id, input: placeFields }).strict(),
  z.object({ kind: z.literal("update_place"), placeId: id, patch: placeFields.partial().refine(nonEmpty) }).strict(),
  z.object({ kind: z.literal("assign_character"), characterId: id, worldId: id, homePlaceId: id.optional(), currentPlaceId: id.optional() }).strict(),
  z.object({ kind: z.literal("update_autonomy"), characterId: id, patch: z.object({
    enabled: z.boolean().optional(), proactiveEnabled: z.boolean().optional(), socialEnabled: z.boolean().optional(),
    dailyMessageLimit: z.number().int().min(0).max(5).optional(), socialDailyLimit: z.number().int().min(0).max(5).optional(),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(), quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(),
  }).strict().refine(nonEmpty) }).strict(),
]);
export type CreatorOperation = z.infer<typeof creatorOperationSchema>;
export const creatorProposalSchema = z.object({
  title: name, reason: z.string().trim().min(1).max(1200), operation: creatorOperationSchema,
}).strict();
export const creatorInspectSchema = z.object({ kind: z.enum(["world", "character", "place"]), id, offset: z.number().int().min(0).max(100000).optional() }).strict();
export type CreatorTarget = z.infer<typeof creatorInspectSchema>;
export type CreatorProposal = {
  id: string; title: string; reason: string; operation: CreatorOperation; before: unknown; after: unknown;
  digest: string; status: "pending" | "applied" | "rejected" | "stale" | "applying" | "interrupted" | "failed";
  result?: unknown; error?: string; createdAt: string; updatedAt: string;
};
export type CreatorMessage = { seq: number; role: "user" | "assistant" | "system"; text: string; createdAt: string };
export class CreatorError extends Error {
  readonly code = "CREATOR_ERROR";
  constructor(message: string, readonly status = 400) { super(message); this.name = "CreatorError"; }
}
