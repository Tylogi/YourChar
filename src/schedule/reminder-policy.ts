import type { ReminderPolicy, ScheduleItem } from "./types.js";

/** Missing policy means a legacy item: never silently move or externally forward it. */
export function reminderPolicy(item: Pick<ScheduleItem, "kind" | "ownerType" | "reminder">): ReminderPolicy {
  return item.reminder ?? { enabled: item.ownerType === "user" && item.kind === "reminder",
    importance: "normal", leadMinutes: 0, prepareMinutes: 10, channels: ["in_app"] };
}

export function normalizeReminderPolicy(input: Partial<ReminderPolicy> | undefined, item: Pick<ScheduleItem, "kind" | "ownerType" | "startAt" | "allDay">): ReminderPolicy {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("reminder policy must be an object");
  if (input && Object.keys(input).some(key => !["enabled", "importance", "leadMinutes", "prepareMinutes", "channels", "channelMode"].includes(key))) throw new Error("unknown reminder policy field");
  const importance = input?.importance ?? (item.kind === "reminder" ? "important" : "normal");
  const policy: ReminderPolicy = {
    enabled: input?.enabled ?? (item.ownerType === "user" && item.kind === "reminder"),
    importance,
    leadMinutes: input?.leadMinutes ?? 0,
    prepareMinutes: input?.prepareMinutes ?? 10,
    channels: input?.channels ?? ["in_app"],
    channelMode: input?.channelMode ?? (input?.channels ? "custom" : "follow_settings"),
  };
  if (!["follow_settings", "custom"].includes(policy.channelMode!)) throw new Error("invalid reminder channelMode");
  if (typeof policy.enabled !== "boolean" || !["normal", "important"].includes(policy.importance)) throw new Error("invalid reminder policy");
  if (!Number.isInteger(policy.leadMinutes) || policy.leadMinutes < 0 || policy.leadMinutes > 10080) throw new Error("reminder leadMinutes must be 0–10080");
  if (!Number.isInteger(policy.prepareMinutes) || policy.prepareMinutes < 1 || policy.prepareMinutes > 30) throw new Error("reminder prepareMinutes must be 1–30");
  if (!Array.isArray(policy.channels) || !policy.channels.length || policy.channels.some(channel => !["in_app", "wechat", "desktop", "feishu"].includes(channel))) throw new Error("invalid reminder channels");
  policy.channels = [...new Set(["in_app" as const, ...policy.channels])];
  if (policy.channelMode === "follow_settings") policy.channels = ["in_app"];
  if (policy.enabled && item.ownerType !== "user") throw new Error("character schedules do not create real reminders");
  if (policy.enabled && (!item.startAt || item.allDay)) throw new Error("a reminder requires an explicit time, not an all-day item");
  return policy;
}
