export function createRuntimeEnvelope(now: Date, requestedTimezone: string): {
  content: string;
  timezone: string;
} {
  const timezone = validTimeZone(requestedTimezone) ? requestedTimezone : "UTC";
  const localMinute = formatLocalMinute(now, timezone);
  const utcMinute = `${now.toISOString().slice(0, 16)}Z`;
  return {
    timezone,
    content: [
      "[RP_AGENT_TURN_CONTEXT v3 | LATEST_VOLATILE_SNAPSHOT]",
      `Time: ${localMinute} ${timezone} (${utcMinute} UTC). This replaces every older volatile time/scene snapshot.`,
    ].join("\n\n"),
  };
}

function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function formatLocalMinute(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}
