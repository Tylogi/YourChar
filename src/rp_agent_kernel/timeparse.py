from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


ZH_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

WEEKDAYS = {
    "一": 0,
    "二": 1,
    "三": 2,
    "四": 3,
    "五": 4,
    "六": 5,
    "日": 6,
    "天": 6,
    "1": 0,
    "2": 1,
    "3": 2,
    "4": 3,
    "5": 4,
    "6": 5,
    "7": 6,
}


@dataclass(frozen=True)
class ParsedTime:
    when: datetime | None
    recurrence: str | None = None
    matched_text: str = ""


def ensure_tz(value: datetime | None, timezone: str) -> datetime:
    tz = ZoneInfo(timezone)
    if value is None:
        return datetime.now(tz)
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def zh_to_int(text: str) -> int:
    stripped = text.strip()
    if stripped.isdigit():
        return int(stripped)
    if stripped in ZH_DIGITS:
        return ZH_DIGITS[stripped]
    if "十" in stripped:
        left, _, right = stripped.partition("十")
        tens = ZH_DIGITS.get(left, 1) if left else 1
        ones = ZH_DIGITS.get(right, 0) if right else 0
        return tens * 10 + ones
    total = 0
    for char in stripped:
        total = total * 10 + ZH_DIGITS.get(char, 0)
    return total


def parse_time_expression(text: str, now: datetime | None = None, timezone: str = "Asia/Shanghai") -> ParsedTime:
    base = ensure_tz(now, timezone)

    relative = re.search(r"([一二两三四五六七八九十\d]+)\s*(分钟|小时|天|周)后", text)
    if relative:
        amount = zh_to_int(relative.group(1))
        unit = relative.group(2)
        delta = {
            "分钟": timedelta(minutes=amount),
            "小时": timedelta(hours=amount),
            "天": timedelta(days=amount),
            "周": timedelta(weeks=amount),
        }[unit]
        return ParsedTime(base + delta, matched_text=relative.group(0))

    recurrence_match = re.search(r"每周([一二三四五六日天1-7])", text)
    if recurrence_match:
        weekday = WEEKDAYS[recurrence_match.group(1)]
        target_date = _next_weekday(base, weekday, include_today=True).date()
        hour, minute, matched = _parse_clock(text)
        if hour is None:
            hour, minute = _default_hour_for_period(text), 0
        recurrence = f"weekly:{['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][weekday]}"
        return ParsedTime(
            datetime.combine(target_date, datetime.min.time(), tzinfo=base.tzinfo).replace(
                hour=hour, minute=minute
            ),
            recurrence=recurrence,
            matched_text=f"{recurrence_match.group(0)} {matched}".strip(),
        )

    date = base.date()
    matched_parts: list[str] = []
    if "后天" in text:
        date = (base + timedelta(days=2)).date()
        matched_parts.append("后天")
    elif "明天" in text or "明晚" in text:
        date = (base + timedelta(days=1)).date()
        matched_parts.append("明晚" if "明晚" in text else "明天")
    elif "今天" in text or "今晚" in text:
        date = base.date()
        matched_parts.append("今晚" if "今晚" in text else "今天")

    next_weekday = re.search(r"下周([一二三四五六日天1-7])", text)
    if next_weekday:
        weekday = WEEKDAYS[next_weekday.group(1)]
        start_next_week = base.date() + timedelta(days=7 - base.weekday())
        date = start_next_week + timedelta(days=weekday)
        matched_parts.append(next_weekday.group(0))
    else:
        weekday_match = re.search(r"(?:周|星期)([一二三四五六日天1-7])", text)
        if weekday_match:
            weekday = WEEKDAYS[weekday_match.group(1)]
            date = _next_weekday(base, weekday, include_today=True).date()
            matched_parts.append(weekday_match.group(0))

    hour, minute, clock_match = _parse_clock(text)
    if hour is None and any(period in text for period in ("早上", "上午", "中午", "下午", "晚上", "今晚", "明晚")):
        hour, minute = _default_hour_for_period(text), 0
    if clock_match:
        matched_parts.append(clock_match)

    if hour is None and not matched_parts:
        return ParsedTime(None)
    if hour is None:
        hour, minute = 9, 0

    when = datetime.combine(date, datetime.min.time(), tzinfo=base.tzinfo).replace(
        hour=hour, minute=minute
    )
    if when <= base and not any(token in text for token in ("今天", "今晚", "明天", "明晚", "后天", "下周")):
        when += timedelta(days=1)
    return ParsedTime(when, matched_text=" ".join(matched_parts))


def _parse_clock(text: str) -> tuple[int | None, int, str]:
    match = re.search(
        r"(早上|上午|中午|下午|晚上|今晚|明晚)?\s*([一二两三四五六七八九十\d]{1,3})点(半|[一二两三四五六七八九十\d]{1,2}分?)?",
        text,
    )
    if not match:
        return None, 0, ""
    period = match.group(1) or ""
    hour = zh_to_int(match.group(2))
    minute_text = match.group(3) or ""
    minute = 30 if minute_text == "半" else 0
    if minute_text and minute_text != "半":
        minute = zh_to_int(minute_text.replace("分", ""))
    if period in {"下午", "晚上", "今晚", "明晚"} and hour < 12:
        hour += 12
    if period == "中午" and hour < 11:
        hour += 12
    return hour, minute, match.group(0).strip()


def _default_hour_for_period(text: str) -> int:
    if "中午" in text:
        return 12
    if "下午" in text:
        return 15
    if "晚上" in text or "今晚" in text or "明晚" in text:
        return 20
    return 9


def _next_weekday(base: datetime, weekday: int, include_today: bool) -> datetime:
    days = weekday - base.weekday()
    if days < 0 or (days == 0 and not include_today):
        days += 7
    return base + timedelta(days=days)


def strip_time_expression(text: str, parsed: ParsedTime) -> str:
    result = text
    if parsed.matched_text:
        for part in parsed.matched_text.split():
            result = result.replace(part, "")
    patterns = [
        r"[今明后]天",
        r"今晚",
        r"明晚",
        r"下周[一二三四五六日天1-7]",
        r"(?:周|星期)[一二三四五六日天1-7]",
        r"每周[一二三四五六日天1-7]",
        r"([一二两三四五六七八九十\d]+)\s*(分钟|小时|天|周)后",
        r"(早上|上午|中午|下午|晚上|今晚|明晚)?\s*([一二两三四五六七八九十\d]{1,3})点(半|[一二两三四五六七八九十\d]{1,2}分?)?",
    ]
    for pattern in patterns:
        result = re.sub(pattern, "", result)
    return re.sub(r"\s+", " ", result).strip(" ，,。.")
