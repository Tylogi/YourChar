import { getZonedDateTimeParts, resolveZonedLocalDateTime } from "../domain/time.js";

export type QuietHoursOptions = {
  start: string;
  end: string;
  timezone: string;
};

export class QuietHoursPolicy {
  private readonly startMinutes: number;
  private readonly endMinutes: number;

  constructor(readonly options: QuietHoursOptions) {
    this.startMinutes = parseClock(options.start, "quiet-hours start");
    this.endMinutes = parseClock(options.end, "quiet-hours end");
    getZonedDateTimeParts(new Date(), options.timezone);
  }

  nextAllowedAt(now: Date): Date | undefined {
    if (this.startMinutes === this.endMinutes) return undefined;
    const local = getZonedDateTimeParts(now, this.options.timezone);
    const currentMinutes = local.hour * 60 + local.minute;
    const crossesMidnight = this.startMinutes > this.endMinutes;
    const inQuiet = crossesMidnight
      ? currentMinutes >= this.startMinutes || currentMinutes < this.endMinutes
      : currentMinutes >= this.startMinutes && currentMinutes < this.endMinutes;
    if (!inQuiet) return undefined;

    const targetDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
    if (crossesMidnight && currentMinutes >= this.startMinutes) {
      targetDate.setUTCDate(targetDate.getUTCDate() + 1);
    }
    const candidates = resolveZonedLocalDateTime(
      {
        year: targetDate.getUTCFullYear(),
        month: targetDate.getUTCMonth() + 1,
        day: targetDate.getUTCDate(),
        hour: Math.floor(this.endMinutes / 60),
        minute: this.endMinutes % 60,
      },
      this.options.timezone,
    ).filter((candidate) => candidate.getTime() > now.getTime());
    return candidates.at(-1);
  }
}

export function quietHoursFromEnvironment(): QuietHoursPolicy | undefined {
  const value = process.env.RP_AGENT_QUIET_HOURS?.trim();
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) {
    throw new Error("RP_AGENT_QUIET_HOURS must use HH:MM-HH:MM");
  }
  return new QuietHoursPolicy({
    start: match[1],
    end: match[2],
    timezone: process.env.RP_AGENT_TIMEZONE ?? "Asia/Shanghai",
  });
}

function parseClock(value: string, label: string): number {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} is outside 00:00-23:59`);
  return hour * 60 + minute;
}
