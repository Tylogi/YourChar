import type { Clock } from "../app/clock.js";
import type { CompanionStore } from "../domain/store.js";
import { parseReminderTime } from "../domain/time.js";
import type { ActionRecord } from "../domain/types.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleItem, ScheduleMutationResult, ScheduleOwnerType } from "../schedule/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const scheduleMcpToolNames = [
  "create_schedule_item",
  "list_schedule_items",
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
  characterId?: string;
  actions: () => ActionRecord[];
};

const scheduleKind = z.enum(["event", "task", "reminder"]);
const scheduleStatus = z.enum(["scheduled", "completed", "cancelled"]);
const scheduleCalendar = z.enum(["user", "character"]);
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

export function createScheduleMcpServer(context: ScheduleMcpContext): McpServer {
  const creationsByTurn = new WeakMap<ActionRecord[], Map<string, ScheduleMutationResult>>();
  const server = new McpServer(
    { name: "rp-agent-schedule", version: "1.0.0" },
    {
      instructions:
        "Schedule tools manage two isolated calendars. calendar=user is real user data and may notify the user; calendar=character is the selected character's fictional schedule and never creates system reminders. Preserve natural-language time in timeExpression and let the server resolve it from its trusted clock.",
    },
  );

  server.registerTool(
    "create_schedule_item",
    {
      title: "Create schedule item",
      description:
        "Create an item in the real user calendar or the selected character's fictional calendar. Character calendars accept events and tasks but never real reminders. Prefer timeExpression for relative or local-language time.",
      inputSchema: z.object({
        calendar: scheduleCalendar.optional().describe("user for the real user calendar; character for the selected character's own fictional schedule. Defaults to user."),
        kind: scheduleKind,
        title: z.string().min(1),
        notes: z.string().optional(),
        ...optionalTime,
        endAt: z.string().optional(),
        timezone: z.string().optional(),
        allDay: z.boolean().optional(),
        recurrenceRule: z.string().optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const owner = scheduleOwner(context, input.calendar);
      const timezone = input.timezone ?? "Asia/Shanghai";
      const startAt = resolveStartAt(input.startAt, input.timeExpression, timezone, context.clock);
      const actions = context.actions();
      const signature = scheduleCreateSignature({ ...input, ...owner, startAt, timezone });
      let creations = creationsByTurn.get(actions);
      if (!creations) {
        creations = new Map();
        creationsByTurn.set(actions, creations);
      }
      const existing = creations.get(signature);
      const result = existing ?? context.scheduleService.create({
          kind: input.kind,
          title: input.title,
          notes: input.notes,
          startAt,
          endAt: input.endAt,
          timezone,
          allDay: input.allDay,
          recurrenceRule: input.recurrenceRule,
          ...owner,
          sourceSessionId: context.sessionId,
          idempotencyKey: mcpToolCallId(extra),
        });
      if (!existing) creations.set(signature, result);
      if (!existing) actions.push(
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
          warnings: result.warnings,
          timeSource: input.timeExpression ? "timeExpression" : input.startAt ? "startAt" : "none",
          ignoredStartAt: Boolean(input.timeExpression && input.startAt),
        }),
      );
      return toolResult(
        `${existing ? "本轮已创建" : "已创建"}${kindLabel(result.item.kind)}：${result.item.title}${result.item.startAt ? `，时间 ${result.item.startAt}` : ""}。`,
        result,
      );
    },
  );

  server.registerTool(
    "list_schedule_items",
    {
      title: "List schedule items",
      description: "List items from the real user calendar or the selected character's fictional calendar.",
      inputSchema: z.object({
        calendar: scheduleCalendar.optional().describe("Defaults to user."),
        from: z.string().optional(),
        to: z.string().optional(),
        status: scheduleStatus.optional(),
        kind: scheduleKind.optional(),
        query: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const owner = scheduleOwner(context, input.calendar);
      const items = context.scheduleService.list({ ...input, ...owner });
      return toolResult(items.length ? JSON.stringify(items) : "没有匹配的日程。", { items });
    },
  );

  server.registerTool(
    "update_schedule_item",
    {
      title: "Update schedule item",
      description: "Update an item in the specified user or character calendar after the target is explicit.",
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
  ]);
}

function scheduleOwner(
  context: ScheduleMcpContext,
  calendar: "user" | "character" | undefined,
): { ownerType: ScheduleOwnerType; characterId?: string } {
  if (calendar !== "character") return { ownerType: "user" };
  if (!context.characterId) throw new Error("character calendar requires a selected character");
  return { ownerType: "character", characterId: context.characterId };
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
