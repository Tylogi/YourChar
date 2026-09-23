import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { CompanionStore } from "../domain/store.js";
import { parseReminderTime } from "../domain/time.js";
import type { ActionRecord, Mode } from "../domain/types.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleItem, ScheduleMutationResult, ScheduleOwnerType } from "../schedule/types.js";
import type { WorldAutonomyCoordinator } from "../world/coordinator.js";
import type { WorldCapabilityId } from "../world/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const scheduleMcpToolNames = [
  "create_schedule_item",
  "create_schedule_items",
  "list_schedule_items",
  "get_schedule_item",
  "update_schedule_item",
  "complete_schedule_item",
  "cancel_schedule_item",
  "snooze_reminder",
] as const;

export type ScheduleMcpContext = {
  scheduleService: ScheduleService;
  store: CompanionStore;
  clock: Clock;
  sessionId: string;
  mode?: Mode;
  characterId?: string;
  worldCoordinator?: WorldAutonomyCoordinator;
  currentUserText?: () => string;
  actions: () => ActionRecord[];
};

const scheduleKind = z.enum(["event", "task", "reminder"]);
const scheduleStatus = z.enum(["scheduled", "completed", "cancelled"]);
const scheduleCalendar = z.enum(["user", "character"]);
const reminderOptions = z.object({
  enabled: z.boolean().optional(), importance: z.enum(["normal", "important"]).optional(),
  leadMinutes: z.number().int().min(0).max(10080).optional().describe("Minutes BEFORE the event time to notify. Keep 0 for an explicit 'remind me at X'; use e.g. 15 only for advance notice of an event."),
  prepareMinutes: z.number().int().min(1).max(30).optional().describe("Background drafting lead before NOTIFICATION time; default 10. Does not change delivery time."),
}).optional().describe("Notification timing and importance only. Channels follow user IM settings and are independent of importance; the Agent cannot change channel preferences.");
const worldCapability = z.enum([
  "rest",
  "work",
  "study",
  "socialize",
  "eat",
  "shop",
  "exercise",
  "travel",
  "create",
  "observe",
  "communicate",
]);
const optionalTime = {
  startAt: z
    .string()
    .optional()
    .describe("Explicit unambiguous ISO 8601 instant. Omit when timeExpression is available."),
  timeExpression: z
    .string()
    .optional()
    .describe("The user's original natural-language time expression. Prefer this over calculating UTC."),
};

const createItemInput = z.object({
  calendar: scheduleCalendar.optional().describe("user for the real user calendar and every reminder; character only for the selected character's fictional events/tasks. Defaults to user. In-person scene perspective does not change ownership."),
  kind: scheduleKind,
  title: z.string().min(1),
  notes: z.string().optional(),
  ...optionalTime,
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  allDay: z.boolean().optional(),
  recurrenceRule: z.string().optional().describe("Only FREQ=DAILY or FREQ=WEEKLY with optional ;INTERVAL=n. No semester cutoff or holiday exceptions; use dated entries for a finite term."),
  reminder: reminderOptions,
  placeId: z.string().optional().describe("Canonical world place ID. Only valid with calendar=character and capabilityId."),
  capabilityId: worldCapability.optional().describe("Fixed world capability. Only valid with calendar=character and placeId."),
});

export function createScheduleMcpServer(context: ScheduleMcpContext): McpServer {
  const creationsByTurn = new WeakMap<ActionRecord[], Map<string, ScheduleMutationResult>>();
  const ownershipGuidance = context.mode === "rp"
    ? "In RP, character plans use calendar=character; real user reminders require the parent Agent's explicit-confirmation policy and calendar=user."
    : "This is a canonical private conversation even when its interaction lens is an in-person scene. Physical co-presence never changes calendar ownership: requests to remind the user use calendar=user.";
  const server = new McpServer(
    { name: "rp-agent-schedule", version: "1.0.0" },
    {
      instructions:
        `Schedule tools manage two isolated calendars. calendar=user is real user data and may notify the user; calendar=character is the selected character's fictional schedule and never creates system reminders. ${ownershipGuidance} Preserve natural-language time in timeExpression and let the server resolve it from its trusted clock. Notification channels are controlled by user IM settings, regardless of importance. Never choose channels or disable IM delivery. Per-reminder channel exceptions must be selected by the user in the schedule editor.`,
    },
  );

  const createItem = (input: z.infer<typeof createItemInput>, idempotencyKey: string, deduplicateByContent = true) => {
    const ownership = scheduleOwnerForCreation(context, input.calendar, input.kind);
    const owner = ownership.owner;
    const timezone = input.timezone ?? "Asia/Shanghai";
    const hasWorldBinding = Boolean(input.placeId || input.capabilityId);
    const persisted = context.scheduleService.repository.findByIdempotencyKey(idempotencyKey);
    const resolvedStartAt = persisted?.startAt ?? resolveStartAt(input.startAt, input.timeExpression, timezone, context.clock);
    const startAt = resolvedStartAt ?? (hasWorldBinding ? context.clock.now().toISOString() : undefined);
    if (hasWorldBinding && owner.ownerType !== "character") {
      throw new Error("world place bindings are only valid for calendar=character");
    }
    if (hasWorldBinding && (!input.placeId || !input.capabilityId)) {
      throw new Error("placeId and capabilityId must be provided together");
    }
    if (hasWorldBinding && (!context.worldCoordinator || !context.characterId)) {
      throw new Error("canonical world scheduling is not enabled for this conversation");
    }
    if (hasWorldBinding) {
      context.worldCoordinator!.validateActivityTarget(
        context.characterId!,
        input.placeId!,
        input.capabilityId!,
      );
    }
    const endAt = input.endAt ?? (hasWorldBinding
      ? defaultWorldActivityEndAt(startAt!, input.capabilityId!)
      : undefined);
    const actions = context.actions();
    const signature = scheduleCreateSignature({ ...input, ...owner, startAt, endAt, timezone });
    let creations = creationsByTurn.get(actions);
    if (!creations) {
      creations = new Map();
      creationsByTurn.set(actions, creations);
    }
    const existingThisTurn = deduplicateByContent ? creations.get(signature) : undefined;
    const existing = existingThisTurn ?? (persisted
      ? { item: persisted, warnings: context.scheduleService.conflictWarnings(persisted), occurrence: context.scheduleService.listOccurrences(persisted.id)[0] }
      : undefined);
    const result = existing ?? context.scheduleService.create({
      kind: input.kind,
      title: input.title,
      notes: input.notes,
      startAt,
      endAt,
      timezone,
      allDay: input.allDay,
      recurrenceRule: input.recurrenceRule,
      reminder: { ...input.reminder, channelMode: "follow_settings" },
      ...owner,
      sourceSessionId: context.sessionId,
      idempotencyKey,
    });
    creations.set(signature, result);
    const worldPlan = hasWorldBinding
      ? context.worldCoordinator!.linkScheduleItem({
          characterId: context.characterId!,
          scheduleItemId: result.item.id,
          placeId: input.placeId!,
          capabilityId: input.capabilityId!,
          summary: input.notes || input.title,
          idempotencyKey: `world-schedule:${result.item.id}`,
        })
      : undefined;
    if (!existingThisTurn) actions.push(
      context.store.addAction("create_schedule_item", "completed", {
        transport: "mcp",
        mcpServer: "rp-agent-schedule",
        scheduleItemId: result.item.id,
        kind: result.item.kind,
        title: result.item.title,
        ownerType: result.item.ownerType,
        characterId: result.item.characterId,
        startAt: result.item.startAt,
        occurrenceId: result.occurrence?.id,
        replayed: Boolean(persisted),
        warnings: result.warnings,
        timeSource: input.timeExpression
          ? "timeExpression"
          : input.startAt
            ? "startAt"
            : hasWorldBinding
              ? "trusted_world_now"
              : "none",
        ignoredStartAt: Boolean(input.timeExpression && input.startAt),
        calendarCorrectedFromCharacter: ownership.correctedFromCharacter,
        worldPlanId: worldPlan?.id,
        placeId: worldPlan?.placeId,
        capabilityId: worldPlan?.capabilityId,
      }),
    );
    return { result, existing: Boolean(existing), worldPlan };
  };

  server.registerTool(
    "create_schedule_item",
    {
      title: "Create schedule item",
      description:
        `Create an item in the real user calendar or the selected character's fictional calendar. kind=reminder always belongs to calendar=user; character calendars accept only events and tasks. ${ownershipGuidance} All new reminders follow the user's IM notification settings, including normal-importance reminders. Never select channels; per-reminder exceptions belong in the user's schedule editor. For a canonical-world location activity, provide both placeId and capabilityId; travel means arrival at the destination when the item ends. A bound world activity with no time starts at trusted server now. Prefer timeExpression for an explicit relative or local-language time.`,
      inputSchema: createItemInput,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const { result, existing, worldPlan } = createItem(input, mcpToolCallId(extra));
      return toolResult(
        `${existing ? "本轮已创建" : "已创建"}${kindLabel(result.item.kind)}：${result.item.title}${result.item.startAt ? `，时间 ${result.item.startAt}` : ""}${worldPlan ? "，并已关联角色世界状态" : ""}。`,
        { ...result, ...(worldPlan ? { worldPlan } : {}) },
      );
    },
  );

  server.registerTool(
    "create_schedule_items",
    {
      title: "Create schedule items in a batch",
      description: `Create 1–50 schedule items per batch for a timetable or other multi-item request. Use multiple batches for a semester. Returns only counts, conflicts and failures, never the full created calendar. Indexes in results are 1-based. Successful items remain saved when another item fails; retry only failed entries with a new batchId. Reuse the same batchId and unchanged entries only to safely replay a batch. All entries share the top-level calendar. ${ownershipGuidance} For world place/capability bindings use create_schedule_item instead.`,
      inputSchema: z.object({
        calendar: scheduleCalendar.optional().describe("One calendar for the whole batch; defaults to user."),
        batchId: z.string().min(1).max(80).describe("Stable unique ID for this batch within this conversation. Reuse unchanged on transport retries; use a new ID for a new batch or corrected entries."),
        items: z.array(createItemInput.omit({ calendar: true, placeId: true, capabilityId: true }).strict()).min(1).max(50),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const owner = scheduleOwner(context, input.calendar);
      const scope = digest([context.sessionId, owner.ownerType, owner.characterId, input.batchId]);
      const summary = {
        batchId: input.batchId, requested: input.items.length, created: 0, existing: 0, failed: 0,
        conflictCount: 0,
        conflicts: [] as Array<{ index: number; id: string; warning: string; additionalWarnings: number }>,
        failures: [] as Array<{ index: number; title: string; time?: string; error: string }>,
      };
      for (const [index, entry] of input.items.entries()) {
        try {
          const prefix = `schedule-batch:${scope}:${index}:`;
          const key = `${prefix}${digest(entry)}`;
          const priorKey = context.scheduleService.repository.findIdempotencyKeyWithPrefix(prefix);
          if (priorKey && priorKey !== key) {
            throw new Error("This batchId/index already saved a different entry. Use a new batchId for corrected entries; existing items were not changed.");
          }
          const { result, existing } = createItem({ ...entry, calendar: input.calendar }, key, false);
          if (existing) summary.existing += 1;
          else summary.created += 1;
          if (result.warnings.length) {
            summary.conflictCount += 1;
            summary.conflicts.push({
              index: index + 1, id: result.item.id,
              warning: shortText(result.warnings[0], 140),
              additionalWarnings: result.warnings.length - 1,
            });
          }
        } catch (error) {
          summary.failed += 1;
          const time = entry.timeExpression ?? entry.startAt;
          summary.failures.push({
            index: index + 1, title: shortText(entry.title, 80),
            ...(time ? { time: shortText(time, 60) } : {}),
            error: shortText(error instanceof Error ? error.message : String(error), 120),
          });
        }
      }
      context.actions().push(context.store.addAction(
        "create_schedule_items",
        summary.created + summary.existing > 0 ? "completed" : "failed",
        { transport: "mcp", mcpServer: "rp-agent-schedule", batchId: input.batchId,
          ...owner, requested: summary.requested, created: summary.created,
          existing: summary.existing, failed: summary.failed, conflictCount: summary.conflictCount },
      ));
      return toolResult(JSON.stringify(summary), summary);
    },
  );

  server.registerTool(
    "list_schedule_items",
    {
      title: "List schedule items",
      description: "Query a bounded page of schedule summaries (default 20, maximum 50). Prefer from/to for the requested day or week and query for a course/title. Results include total, hasMore and nextOffset; keep the same filters when fetching another page. Fetch only pages needed for the user's request. Notes are previews; use get_schedule_item for full details. Dates filter stored startAt values, not expanded recurrence occurrences.",
      inputSchema: z.object({
        calendar: scheduleCalendar.optional().describe("Defaults to user."),
        from: z.string().optional().describe("Inclusive start instant, ISO 8601 with timezone."),
        to: z.string().optional().describe("Exclusive end instant, ISO 8601 with timezone."),
        status: scheduleStatus.optional(),
        kind: scheduleKind.optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const owner = scheduleOwner(context, input.calendar);
      const page = context.scheduleService.listPage({ ...input, ...owner }, input);
      const items: ReturnType<typeof scheduleSummary>[] = [];
      let characters = 0;
      for (const item of page.items) {
        const summary = scheduleSummary(item);
        const size = JSON.stringify(summary).length + 1;
        if (items.length && characters + size > 20_000) break;
        items.push(summary);
        characters += size;
      }
      const nextOffset = page.offset + items.length;
      const result = {
        items, total: page.total, offset: page.offset, limit: page.limit,
        returned: items.length, hasMore: nextOffset < page.total,
        ...(nextOffset < page.total ? { nextOffset } : {}),
      };
      return toolResult(JSON.stringify(result), result);
    },
  );

  server.registerTool(
    "get_schedule_item",
    {
      title: "Read schedule item details",
      description: "Read one owned schedule item by ID, with a bounded slice of its notes (default), title, or recurrenceRule. Use nextOffset and the same field to continue long text. This does not load the rest of the calendar.",
      inputSchema: z.object({
        calendar: scheduleCalendar.optional(), id: z.string(),
        field: z.enum(["notes", "title", "recurrenceRule"]).optional(),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(2).max(4000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const item = context.scheduleService.get(input.id);
      assertScheduleOwner(context, item, input.calendar);
      const field = input.field ?? "notes";
      const source = item[field] ?? "";
      const offset = input.offset ?? 0;
      const text = sliceText(source.slice(offset), input.limit ?? 2000);
      const nextOffset = offset + text.length;
      const result = {
        item: scheduleSummary(item), reminder: item.reminder,
        field, text, offset, totalCharacters: source.length, hasMore: nextOffset < source.length,
        ...(nextOffset < source.length ? { nextOffset } : {}),
      };
      return toolResult(JSON.stringify(result), result);
    },
  );

  server.registerTool(
    "update_schedule_item",
    {
      title: "Update schedule item",
      description: "Update an item in the specified user or character calendar after the target is explicit. Preserve the user's channel policy: importance never changes notification channels; channel exceptions must be chosen in the schedule editor.",
      inputSchema: z.object({
        calendar: scheduleCalendar.optional().describe("Defaults to user."),
        id: z.string(),
        title: z.string().optional(),
        notes: z.string().optional(),
        ...optionalTime,
        endAt: z.string().optional(),
        timezone: z.string().optional(),
        allDay: z.boolean().optional(),
        recurrenceRule: z.string().optional(),
        reminder: reminderOptions,
      }),
      annotations: { destructiveHint: false },
    },
    async (input) => {
      const current = context.scheduleService.get(input.id);
      assertScheduleOwner(context, current, input.calendar);
      const timezone = input.timezone ?? current.timezone;
      const result = context.scheduleService.update(input.id, {
        title: input.title,
        notes: input.notes,
        startAt: resolveStartAt(input.startAt, input.timeExpression, timezone, context.clock),
        endAt: input.endAt,
        timezone: input.timezone,
        allDay: input.allDay,
        recurrenceRule: input.recurrenceRule,
        reminder: input.reminder,
      });
      context.actions().push(
        context.store.addAction("update_schedule_item", "completed", {
          transport: "mcp",
          mcpServer: "rp-agent-schedule",
          scheduleItemId: result.item.id,
          warnings: result.warnings,
        }),
      );
      return toolResult(`已更新日程：${result.item.title}。`, result);
    },
  );

  server.registerTool(
    "complete_schedule_item",
    {
      title: "Complete schedule item",
      description: "Mark an item in the specified user or character calendar completed.",
      inputSchema: z.object({ id: z.string(), calendar: scheduleCalendar.optional().describe("Defaults to user.") }),
      annotations: { destructiveHint: false },
    },
    async ({ id, calendar }) => {
      assertScheduleOwner(context, context.scheduleService.get(id), calendar);
      const item = context.scheduleService.complete(id);
      recordItemAction(context, "complete_schedule_item", item.id);
      return toolResult(`已完成：${item.title}。`, item);
    },
  );

  server.registerTool(
    "cancel_schedule_item",
    {
      title: "Cancel schedule item",
      description: "Cancel an item in the specified user or character calendar only after the target is explicit.",
      inputSchema: z.object({ id: z.string(), calendar: scheduleCalendar.optional().describe("Defaults to user.") }),
      annotations: { destructiveHint: true },
    },
    async ({ id, calendar }) => {
      assertScheduleOwner(context, context.scheduleService.get(id), calendar);
      const item = context.scheduleService.cancel(id);
      recordItemAction(context, "cancel_schedule_item", item.id);
      return toolResult(`已取消：${item.title}。`, item);
    },
  );

  server.registerTool(
    "snooze_reminder",
    {
      title: "Snooze reminder",
      description: "Snooze one reminder occurrence by a positive number of minutes.",
      inputSchema: z.object({ occurrenceId: z.string(), minutes: z.number().positive() }),
      annotations: { destructiveHint: false },
    },
    async ({ occurrenceId, minutes }) => {
      const occurrence = context.scheduleService.snooze(occurrenceId, minutes);
      context.actions().push(
        context.store.addAction("snooze_reminder", "completed", {
          transport: "mcp",
          mcpServer: "rp-agent-schedule",
          occurrenceId: occurrence.id,
          dueAt: occurrence.dueAt,
        }),
      );
      return toolResult(`已稍后提醒，新时间 ${occurrence.dueAt}。`, occurrence);
    },
  );

  return server;
}

function scheduleCreateSignature(input: {
  kind: string;
  title: string;
  notes?: string;
  startAt?: string;
  endAt?: string;
  timezone: string;
  allDay?: boolean;
  recurrenceRule?: string;
  ownerType: ScheduleOwnerType;
  characterId?: string;
  placeId?: string;
  capabilityId?: WorldCapabilityId;
}): string {
  return JSON.stringify([
    input.kind,
    input.title.trim(),
    input.notes?.trim() ?? null,
    input.startAt ?? null,
    input.endAt ?? null,
    input.timezone,
    Boolean(input.allDay),
    input.recurrenceRule?.trim() ?? null,
    input.ownerType,
    input.characterId ?? null,
    input.placeId ?? null,
    input.capabilityId ?? null,
  ]);
}

function defaultWorldActivityEndAt(startAt: string, capabilityId: WorldCapabilityId): string {
  const durationMinutes = capabilityId === "travel" ? 30 : 60;
  return new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString();
}

function scheduleOwner(
  context: ScheduleMcpContext,
  calendar: "user" | "character" | undefined,
): { ownerType: ScheduleOwnerType; characterId?: string } {
  if (calendar !== "character") return { ownerType: "user" };
  if (!context.characterId) throw new Error("character calendar requires a selected character");
  return { ownerType: "character", characterId: context.characterId };
}

function scheduleOwnerForCreation(
  context: ScheduleMcpContext,
  calendar: "user" | "character" | undefined,
  kind: "event" | "task" | "reminder",
): {
  owner: { ownerType: ScheduleOwnerType; characterId?: string };
  correctedFromCharacter: boolean;
} {
  if (calendar === "character" && kind === "reminder") {
    const explicitUserReminder = context.mode === "sms" && isExplicitUserReminder(context.currentUserText?.() ?? "");
    if (explicitUserReminder) {
      return { owner: { ownerType: "user" }, correctedFromCharacter: true };
    }
    throw new Error(
      "calendar=character cannot create reminders. If the user asked to be reminded, retry with calendar=user; for the character's own plan use kind=event or kind=task. Physical co-presence does not change calendar ownership.",
    );
  }
  return { owner: scheduleOwner(context, calendar), correctedFromCharacter: false };
}

function isExplicitUserReminder(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/(?:不要|别|不用|无需|取消).{0,6}(?:提醒|叫|通知)我/u.test(normalized)) return false;
  if (/\b(?:do\s+not|don't|dont|no\s+need\s+to)\s+remind\s+me\b/iu.test(normalized)) return false;
  return /(?:提醒|叫|通知)我/u.test(normalized) || /\bremind\s+me\b/iu.test(normalized);
}

function assertScheduleOwner(
  context: ScheduleMcpContext,
  item: ScheduleItem,
  calendar: "user" | "character" | undefined,
): void {
  const owner = scheduleOwner(context, calendar);
  if (item.ownerType !== owner.ownerType || item.characterId !== owner.characterId) {
    throw new Error("schedule item does not belong to the requested calendar");
  }
}

export async function createScheduleMcpBridge(context: ScheduleMcpContext): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createScheduleMcpServer(context),
    `rp-agent-pi-${context.sessionId}`,
  );
}

function resolveStartAt(
  startAt: string | undefined,
  timeExpression: string | undefined,
  timezone: string,
  clock: Clock,
): string | undefined {
  return timeExpression
    ? parseReminderTime(timeExpression, clock.now(), timezone).toISOString()
    : startAt;
}

function mcpToolCallId(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): string {
  const value = extra._meta?.["rp-agent/tool-call-id"];
  return typeof value === "string" && value ? value : `mcp-${String(extra.requestId)}`;
}

function recordItemAction(
  context: ScheduleMcpContext,
  actionType: "complete_schedule_item" | "cancel_schedule_item",
  scheduleItemId: string,
): void {
  context.actions().push(
    context.store.addAction(actionType, "completed", {
      transport: "mcp",
      mcpServer: "rp-agent-schedule",
      scheduleItemId,
    }),
  );
}

function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: asRecord(structuredContent),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function kindLabel(kind: "event" | "task" | "reminder"): string {
  return kind === "event" ? "事件" : kind === "task" ? "任务" : "提醒";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sliceText(value: string, limit: number): string {
  const result = value.slice(0, limit);
  return result.length < value.length ? result.replace(/[\uD800-\uDBFF]$/u, "") : result;
}

function shortText(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return normalized.length <= limit ? normalized : `${sliceText(normalized, limit)}…`;
}

function scheduleSummary(item: ScheduleItem) {
  return {
    id: item.id, kind: item.kind, title: shortText(item.title, 160),
    startAt: item.startAt, endAt: item.endAt, timezone: item.timezone,
    allDay: item.allDay, status: item.status,
    ownerType: item.ownerType, characterId: item.characterId,
    recurrenceRule: item.recurrenceRule ? shortText(item.recurrenceRule, 80) : undefined,
    notesPreview: item.notes ? shortText(item.notes, 200) : undefined,
    truncatedFields: (["title", "notes", "recurrenceRule"] as const).filter(field =>
      (item[field]?.length ?? 0) > ({ title: 160, notes: 200, recurrenceRule: 80 })[field]),
  };
}
