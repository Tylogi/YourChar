export type DueReminderContext = {
  outboxId: string;
  occurrenceId: string;
  scheduleItemId: string;
  sourceSessionId?: string;
  title: string;
  notes?: string;
  dueAt: string;
  timezone: string;
  eventAt?: string;
};

export type ComposedReminderMessage = {
  body: string;
  agentGenerated: boolean;
};

export interface ReminderMessageComposer {
  compose(reminder: DueReminderContext, signal?: AbortSignal): Promise<ComposedReminderMessage>;
}
