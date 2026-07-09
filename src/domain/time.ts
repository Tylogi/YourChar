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

export function parseReminderTime(text: string, now: Date): Date {
  const minuteMatch = text.match(/(\d+)\s*分钟后/);
  if (minuteMatch) {
    return new Date(now.getTime() + Number(minuteMatch[1]) * 60_000);
  }
  const hourMatch = text.match(/(\d+)\s*小时后/);
  if (hourMatch) {
    return new Date(now.getTime() + Number(hourMatch[1]) * 3_600_000);
  }
  return new Date(now.getTime() + 3_600_000);
}

export function extractReminderTitle(text: string): string {
  const match = text.match(/提醒我(.+?)(?:。|！|!|$)/);
  if (!match) {
    return "提醒";
  }
  return stripTimeWords(match[1]).trim() || "提醒";
}

function stripTimeWords(text: string): string {
  return text
    .replace(/(\d+)\s*分钟后/g, "")
    .replace(/(\d+)\s*小时后/g, "")
    .replace(/今晚|明天|后天|下午|上午|中午|晚上|早上/g, "")
    .trim();
}
