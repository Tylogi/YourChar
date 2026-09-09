export type ScheduleItemKind = "event" | "task" | "reminder";
export type ScheduleItemStatus = "scheduled" | "completed" | "cancelled";
export type ScheduleOwnerType = "user" | "character";
export type ReminderChannel = "in_app" | "wechat" | "desktop" | "feishu";
export type ReminderPolicy = {
  enabled: boolean;
  importance: "normal" | "important";
  leadMinutes: number;
  prepareMinutes: number;
  channels: ReminderChannel[];
  /** Missing on historical policies means the existing explicit channels remain authoritative. */
  channelMode?: "follow_settings" | "custom";
};

export type ScheduleItem = {
  id: string;
  kind: ScheduleItemKind;
  title: string;
  notes?: string;
  startAt?: string;
  endAt?: string;
  timezone: string;
  allDay: boolean;
  recurrenceRule?: string;
  status: ScheduleItemStatus;
  ownerType: ScheduleOwnerType;
  characterId?: string;
  sourceSessionId?: string;
  reminder?: ReminderPolicy;
  revision?: number;
  createdAt: string;
  updatedAt: string;
};

export type ReminderOccurrenceStatus =
  | "scheduled"
  | "processing"
  | "delivered"
  | "snoozed"
  | "cancelled"
  | "failed";

export type ReminderOccurrence = {
  id: string;
  scheduleItemId: string;
  dueAt: string;
  eventAt?: string;
  acknowledgedAt?: string;
  acknowledgedVia?: string;
  status: ReminderOccurrenceStatus;
  snoozedFromId?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotificationOutboxStatus = "pending" | "processing" | "delivered" | "failed";

export type NotificationOutboxEntry = {
  id: string;
  occurrenceId: string;
  channel: string;
  status: NotificationOutboxStatus;
  attempts: number;
  availableAt: string;
  lastError?: string;
  deliveryTitle?: string;
  deliveryBody?: string;
  agentGenerated: boolean;
  composedAt?: string;
  suppressedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleListFilter = {
  from?: string;
  to?: string;
  status?: ScheduleItemStatus;
  kind?: ScheduleItemKind;
  ownerType?: ScheduleOwnerType;
  characterId?: string;
  query?: string;
};

export type CreateScheduleItemInput = {
  kind: ScheduleItemKind;
  title: string;
  notes?: string;
  startAt?: string;
  endAt?: string;
  timezone: string;
  allDay?: boolean;
  recurrenceRule?: string;
  ownerType?: ScheduleOwnerType;
  characterId?: string;
  sourceSessionId?: string;
  idempotencyKey?: string;
  reminder?: Partial<ReminderPolicy>;
};

export type UpdateScheduleItemInput = Partial<
  Pick<
    ScheduleItem,
    "title" | "notes" | "startAt" | "endAt" | "timezone" | "allDay" | "recurrenceRule"
  >
> & { reminder?: Partial<ReminderPolicy> };

export type ScheduleMutationResult = {
  item: ScheduleItem;
  occurrence?: ReminderOccurrence;
  warnings: string[];
};

export type ScheduleMutationEvent = {
  type: "created" | "updated" | "completed" | "cancelled" | "snoozed";
  item: ScheduleItem;
  previousItem?: ScheduleItem;
  occurrence?: ReminderOccurrence;
  snoozeMinutes?: number;
};

export type ScheduleMutationListener = (event: ScheduleMutationEvent) => void;
