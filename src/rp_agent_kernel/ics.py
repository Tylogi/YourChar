from __future__ import annotations

from datetime import datetime

from .models import CalendarEvent, CalendarEventCreate


def export_ics(events: list[CalendarEvent]) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Companion Kernel//Prototype//EN",
    ]
    for event in events:
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{event.id}",
                f"SUMMARY:{_escape(event.title)}",
                f"DTSTART:{_format_dt(event.start)}",
            ]
        )
        if event.end:
            lines.append(f"DTEND:{_format_dt(event.end)}")
        if event.location:
            lines.append(f"LOCATION:{_escape(event.location)}")
        if event.recurrence and event.recurrence.startswith("weekly:"):
            lines.append(f"RRULE:FREQ=WEEKLY;BYDAY={event.recurrence.split(':', 1)[1]}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def import_ics(text: str, timezone: str = "Asia/Shanghai") -> list[CalendarEventCreate]:
    events: list[CalendarEventCreate] = []
    current: dict[str, str] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT" and current is not None:
            if "SUMMARY" in current and "DTSTART" in current:
                events.append(
                    CalendarEventCreate(
                        title=_unescape(current["SUMMARY"]),
                        start=_parse_dt(current["DTSTART"]),
                        end=_parse_dt(current["DTEND"]) if "DTEND" in current else None,
                        timezone=timezone,
                        location=_unescape(current["LOCATION"]) if "LOCATION" in current else None,
                        recurrence=_parse_rrule(current.get("RRULE")),
                    )
                )
            current = None
        elif current is not None and ":" in line:
            key, value = line.split(":", 1)
            current[key.split(";", 1)[0]] = value
    return events


def _format_dt(value: datetime) -> str:
    return value.strftime("%Y%m%dT%H%M%S")


def _parse_dt(value: str) -> datetime:
    cleaned = value.rstrip("Z")
    if "T" in cleaned:
        return datetime.strptime(cleaned, "%Y%m%dT%H%M%S")
    return datetime.strptime(cleaned, "%Y%m%d")


def _parse_rrule(value: str | None) -> str | None:
    if not value or "FREQ=WEEKLY" not in value or "BYDAY=" not in value:
        return None
    return "weekly:" + value.split("BYDAY=", 1)[1].split(";", 1)[0]


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;")


def _unescape(value: str) -> str:
    return value.replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
