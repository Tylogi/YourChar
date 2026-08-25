const WORLD_LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * Formats an instant as an offset-free wall-clock value in the selected world.
 * This representation is intended for planner I/O only; durable schedules still
 * store UTC instants.
 */
export function formatWorldLocalDateTime(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return [
    pad(parts.year, 4),
    "-",
    pad(parts.month),
    "-",
    pad(parts.day),
    "T",
    pad(parts.hour),
    ":",
    pad(parts.minute),
    ":",
    pad(parts.second),
  ].join("");
}

/**
 * Resolves an offset-free wall-clock value through an IANA timezone. Ambiguous
 * and nonexistent DST clock readings are rejected instead of guessed.
 */
export function worldLocalDateTimeToInstant(value: string, timezone: string): Date | undefined {
  const match = WORLD_LOCAL_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const wanted: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (
    wanted.month < 1 || wanted.month > 12 ||
    wanted.day < 1 || wanted.day > 31 ||
    wanted.hour > 23 || wanted.minute > 59 || wanted.second > 59
  ) return undefined;

  const localEpoch = Date.UTC(
    wanted.year,
    wanted.month - 1,
    wanted.day,
    wanted.hour,
    wanted.minute,
    wanted.second,
  );
  const matches = new Map<number, Date>();
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(localEpoch - offsetMinutes * 60_000);
    if (sameParts(zonedParts(candidate, timezone), wanted)) {
      matches.set(candidate.getTime(), candidate);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function zonedParts(date: Date, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function sameParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
