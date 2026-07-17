export type TimeResolutionCode =
  | "AMBIGUOUS_TIME"
  | "INVALID_TIME"
  | "INVALID_TIMEZONE"
  | "PAST_TIME";

export class TimeResolutionError extends Error {
  constructor(
    readonly code: TimeResolutionCode,
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "TimeResolutionError";
  }
}

export function resolveNow(value?: string): Date {
  if (!value) {
    return new Date();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid now: ${value}`);
  }
  return date;
}

export function parseReminderTime(text: string, now: Date, timezone = "Asia/Shanghai"): Date {
  assertTimezone(timezone);

  const relative = parseRelativeTime(text, now);
  if (relative) {
    return relative;
  }

  const explicitIso = parseExplicitIso(text, timezone);
  if (explicitIso) {
    assertFuture(explicitIso, now);
    return explicitIso;
  }

  const localNow = zonedParts(now, timezone);
  const date = resolveLocalDate(text, localNow);
  const time = resolveLocalTime(text);
  if (!date.hasDateMarker && !time) {
    throw new TimeResolutionError("AMBIGUOUS_TIME", "没有识别到明确的提醒时间");
  }
  if (!time) {
    throw new TimeResolutionError("AMBIGUOUS_TIME", "请补充具体时间，例如下午三点");
  }

  const candidates = zonedLocalToInstants(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: time.hour,
      minute: time.minute,
    },
    timezone,
  );
  if (candidates.length === 0) {
    throw new TimeResolutionError("INVALID_TIME", "该本地时间不存在，可能处于夏令时切换区间");
  }
  if (candidates.length > 1) {
    throw new TimeResolutionError(
      "AMBIGUOUS_TIME",
      "该本地时间对应两个时刻，请明确时区偏移",
      candidates.map((candidate) => candidate.toISOString()),
    );
  }
  assertFuture(candidates[0], now);
  return candidates[0];
}

export function addZonedCalendarDays(instant: string, days: number, timezone: string): string {
  assertTimezone(timezone);
  const source = new Date(instant);
  if (Number.isNaN(source.getTime())) {
    throw new TimeResolutionError("INVALID_TIME", `无效时间：${instant}`);
  }
  const local = zonedParts(source, timezone);
  const shifted = addCalendarDays(local, days, true);
  const candidates = zonedLocalToInstants(
    {
      year: shifted.year,
      month: shifted.month,
      day: shifted.day,
      hour: local.hour,
      minute: local.minute,
    },
    timezone,
  );
  if (candidates.length !== 1) {
    throw new TimeResolutionError(
      candidates.length ? "AMBIGUOUS_TIME" : "INVALID_TIME",
      candidates.length ? "重复日程落在夏令时歧义时间" : "重复日程落在不存在的本地时间",
      candidates.map((candidate) => candidate.toISOString()),
    );
  }
  return candidates[0].toISOString();
}

export function getZonedDateTimeParts(date: Date, timezone: string) {
  assertTimezone(timezone);
  return zonedParts(date, timezone);
}

export function resolveZonedLocalDateTime(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date[] {
  assertTimezone(timezone);
  return zonedLocalToInstants(local, timezone);
}

export function extractReminderTitle(text: string): string {
  const marker = text.match(/(?:提醒我|提醒一下|记得提醒(?:我)?)(.+?)(?:。|！|!|$)/);
  const source = marker?.[1] ?? text;
  const title = stripTimeWords(source)
    .replace(/^(?:在|于|到时候)\s*/g, "")
    .replace(/^[，,：:\s]+|[，,：:\s]+$/g, "")
    .trim();
  return title || "提醒";
}

function parseRelativeTime(text: string, now: Date): Date | undefined {
  const units: Array<{ pattern: RegExp; milliseconds: number }> = [
    {
      pattern: /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*分钟(?:后|之后|以后)/,
      milliseconds: 60_000,
    },
    {
      pattern: /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*小时(?:后|之后|以后)/,
      milliseconds: 3_600_000,
    },
    {
      pattern: /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*天(?:后|之后|以后)/,
      milliseconds: 86_400_000,
    },
  ];
  for (const unit of units) {
    const match = text.match(unit.pattern);
    if (match) {
      const amount = parseNumber(match[1]);
      if (amount <= 0) {
        throw new TimeResolutionError("INVALID_TIME", "相对时间必须大于零");
      }
      return new Date(now.getTime() + amount * unit.milliseconds);
    }
  }
  return undefined;
}

function parseExplicitIso(text: string, timezone: string): Date | undefined {
  const match = text.match(
    /(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?\s*(Z|[+-]\d{2}:?\d{2})?/i,
  );
  if (!match) {
    return undefined;
  }
  if (match[6]) {
    const normalized = match[0].trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      throw new TimeResolutionError("INVALID_TIME", "ISO 时间格式无效");
    }
    return date;
  }
  const candidates = zonedLocalToInstants(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    },
    timezone,
  );
  if (candidates.length !== 1) {
    throw new TimeResolutionError(
      candidates.length ? "AMBIGUOUS_TIME" : "INVALID_TIME",
      candidates.length ? "ISO 本地时间存在两个可能时刻" : "ISO 本地时间不存在",
      candidates.map((candidate) => candidate.toISOString()),
    );
  }
  return candidates[0];
}

function resolveLocalDate(
  text: string,
  now: { year: number; month: number; day: number },
): { year: number; month: number; day: number; hasDateMarker: boolean } {
  const explicit = text.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})[日号]?/);
  if (explicit) {
    return {
      year: explicit[1] ? Number(explicit[1]) : now.year,
      month: Number(explicit[2]),
      day: Number(explicit[3]),
      hasDateMarker: true,
    };
  }

  const dayOffset = text.includes("后天") ? 2 : text.includes("明天") ? 1 : 0;
  if (dayOffset || /今天|今晚|今早|今晨/.test(text)) {
    return addCalendarDays(now, dayOffset, true);
  }

  const weekdayMatch = text.match(/(?:下)?(?:周|星期)([一二三四五六日天])/);
  if (weekdayMatch) {
    const target = "一二三四五六日".indexOf(weekdayMatch[1]) + 1;
    const currentDate = new Date(Date.UTC(now.year, now.month - 1, now.day));
    const current = currentDate.getUTCDay() || 7;
    let offset = text.includes("下周") ? 7 - current + target : (target - current + 7) % 7;
    if (offset === 0) offset = 7;
    return addCalendarDays(now, offset, true);
  }

  return { ...now, hasDateMarker: false };
}

function resolveLocalTime(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*(?:点|时|[:：])\s*(?:(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*分?|半)?/,
  );
  if (!match) {
    return undefined;
  }
  const period = match[1] ?? "";
  let hour = parseNumber(match[2]);
  const minute = match[3] ? parseNumber(match[3]) : match[0].includes("半") ? 30 : 0;
  if (hour > 24 || minute > 59) {
    throw new TimeResolutionError("INVALID_TIME", "小时或分钟超出范围");
  }
  if (["下午", "傍晚", "晚上"].includes(period) && hour < 12) {
    hour += 12;
  } else if (period === "中午" && hour < 11) {
    hour += 12;
  } else if (period === "凌晨" && hour === 12) {
    hour = 0;
  }
  if (hour === 24) {
    hour = 0;
  }
  return { hour, minute };
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
  hasDateMarker: boolean,
) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hasDateMarker,
  };
}

function zonedLocalToInstants(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date[] {
  const localEpoch = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const matches = new Map<number, Date>();
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(localEpoch - offsetMinutes * 60_000);
    const parts = zonedParts(candidate, timezone);
    if (
      parts.year === local.year &&
      parts.month === local.month &&
      parts.day === local.day &&
      parts.hour === local.hour &&
      parts.minute === local.minute
    ) {
      matches.set(candidate.getTime(), candidate);
    }
  }
  return [...matches.values()].sort((left, right) => left.getTime() - right.getTime());
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new TimeResolutionError("INVALID_TIMEZONE", `无效时区：${timezone}`);
  }
}

function assertFuture(value: Date, now: Date): void {
  if (value.getTime() <= now.getTime()) {
    throw new TimeResolutionError("PAST_TIME", "提醒时间已经过去，请提供未来时间");
  }
}

function stripTimeWords(text: string): string {
  return text
    .replace(
      /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*(?:分钟|小时|天)(?:后|之后|以后)/g,
      "",
    )
    .replace(/(?:(?:\d{4})年)?\s*\d{1,2}月\s*\d{1,2}[日号]?/g, "")
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gi, "")
    .replace(/(?:下)?(?:周|星期)[一二三四五六日天]/g, "")
    .replace(
      /(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]+)\s*(?:点|时|[:：])\s*(?:(?:\d{1,2}|[零〇一二两三四五六七八九十]+)\s*分?|半)?/g,
      "",
    )
    .replace(/今天|今晚|今早|今晨|明天|后天/g, "")
    .trim();
}

function parseNumber(value: string): number {
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value === "半") {
    return 0.5;
  }

  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!/[十百千万]/.test(value)) {
    return Number([...value].map((character) => digits[character]).join(""));
  }

  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digits) {
      digit = digits[character];
    } else if (character === "万") {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * units[character];
      digit = 0;
    }
  }
  return total + section + digit;
}
