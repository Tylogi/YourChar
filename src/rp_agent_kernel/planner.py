from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .models import MessageRequest
from .timeparse import ParsedTime, ensure_tz, parse_time_expression, strip_time_expression


@dataclass(frozen=True)
class PlannedOperation:
    op_type: str
    feature: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    requires_confirmation: bool = False
    reason: str | None = None


@dataclass(frozen=True)
class Plan:
    operations: list[PlannedOperation]
    parsed_time: ParsedTime
    now: datetime


class Planner:
    def plan(self, request: MessageRequest) -> Plan:
        now = ensure_tz(request.now, request.timezone)
        parsed_time = parse_time_expression(request.text, now, request.timezone)
        text = request.text.strip()
        operations: list[PlannedOperation] = []
        real_ops_allowed = request.mode == "sms" or _rp_allows_real_ops(text)

        if real_ops_allowed and _is_bulk_delete(text):
            operations.append(
                PlannedOperation(
                    op_type="bulk_delete_calendar",
                    feature="calendar",
                    payload={"scope": "all_calendar_events"},
                    requires_confirmation=True,
                    reason="大范围删除日程需要确认。",
                )
            )
        elif real_ops_allowed and _is_reschedule(text):
            operations.append(
                PlannedOperation(
                    op_type="reschedule_calendar",
                    feature="calendar",
                    payload={"text": text, "targetTime": parsed_time.when.isoformat() if parsed_time.when else None},
                    requires_confirmation=True,
                    reason="重要改期需要确认。",
                )
            )
        elif real_ops_allowed and _is_schedule_query(text):
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=7)
            if "今天" in text:
                end = start + timedelta(days=1)
            elif "明天" in text:
                start = start + timedelta(days=1)
                end = start + timedelta(days=1)
            operations.append(
                PlannedOperation(
                    op_type="list_calendar",
                    feature="calendar",
                    payload={"start": start.isoformat(), "end": end.isoformat()},
                )
            )
        elif real_ops_allowed and _is_task_query(text):
            operations.append(PlannedOperation(op_type="list_tasks", feature="tasks"))
        elif real_ops_allowed and _is_reminder_create(text):
            title = _extract_title(text, parsed_time, fallback="提醒")
            operations.append(
                PlannedOperation(
                    op_type="create_reminder",
                    feature="reminders",
                    payload={
                        "title": title,
                        "remindAt": (parsed_time.when or now + timedelta(hours=1)).isoformat(),
                        "timezone": request.timezone,
                    },
                )
            )
        elif real_ops_allowed and _is_task_create(text):
            title = _extract_title(text, parsed_time, fallback="待办")
            operations.append(
                PlannedOperation(
                    op_type="create_task",
                    feature="tasks",
                    payload={
                        "title": title,
                        "dueAt": parsed_time.when.isoformat() if parsed_time.when else None,
                        "timezone": request.timezone,
                    },
                )
            )
        elif real_ops_allowed and _is_calendar_create(text) and parsed_time.when is not None:
            title = _extract_title(text, parsed_time, fallback="日程")
            operations.append(
                PlannedOperation(
                    op_type="create_calendar",
                    feature="calendar",
                    payload={
                        "title": title,
                        "start": parsed_time.when.isoformat(),
                        "end": (parsed_time.when + timedelta(hours=1)).isoformat(),
                        "timezone": request.timezone,
                        "recurrence": parsed_time.recurrence,
                    },
                )
            )

        if request.mode == "rp" and text:
            operations.append(
                PlannedOperation(
                    op_type="write_rp_memory",
                    feature="rp_memory",
                    payload={
                        "content": text,
                        "tags": ["rp", *(["character"] if request.character_id else [])],
                    },
                )
            )
        elif request.mode == "sms" and _is_secretary_memory(text):
            operations.append(
                PlannedOperation(
                    op_type="write_secretary_memory",
                    feature="secretary_memory",
                    payload={
                        "content": _strip_memory_prefix(text),
                        "tags": ["preference", "secretary"],
                    },
                )
            )

        if not operations:
            operations.append(PlannedOperation(op_type="noop"))
        return Plan(operations=operations, parsed_time=parsed_time, now=now)


def _rp_allows_real_ops(text: str) -> bool:
    return text.startswith("/real") or "现实日程" in text or "真实日程" in text or "现实提醒" in text


def _is_bulk_delete(text: str) -> bool:
    return bool(re.search(r"(删除|清空).*(全部|所有).*(日程|安排|提醒|任务)?", text))


def _is_reschedule(text: str) -> bool:
    return any(word in text for word in ("改期", "改到", "推迟", "延期"))


def _is_schedule_query(text: str) -> bool:
    return any(word in text for word in ("有什么安排", "查看日程", "查询日程", "列出日程", "schedule"))


def _is_task_query(text: str) -> bool:
    return any(word in text for word in ("查看任务", "查询任务", "列出任务", "待办列表", "todo list"))


def _is_reminder_create(text: str) -> bool:
    return "提醒" in text and not _is_schedule_query(text)


def _is_task_create(text: str) -> bool:
    return any(word in text for word in ("任务", "待办", "todo")) and not _is_task_query(text)


def _is_calendar_create(text: str) -> bool:
    return any(word in text for word in ("安排", "预约", "日程", "会议", "开会", "见"))


def _is_secretary_memory(text: str) -> bool:
    if any(word in text for word in ("什么", "查询", "查看", "告诉我", "？", "?")):
        return "记住" in text
    if "记住" in text or "我喜欢" in text or "我不喜欢" in text:
        return True
    return bool(re.search(r"(我的)?偏好\s*[:：是为]", text))


def _strip_memory_prefix(text: str) -> str:
    return re.sub(r"^(请)?(帮我)?记住[:：]?", "", text).strip()


def _extract_title(text: str, parsed_time: ParsedTime, fallback: str) -> str:
    cleaned = strip_time_expression(text, parsed_time)
    cleaned = cleaned.replace("/real", "")
    for token in (
        "请",
        "帮我",
        "提醒我",
        "提醒",
        "安排",
        "预约",
        "日程",
        "任务",
        "待办",
        "现实日程",
        "真实日程",
        "现实提醒",
    ):
        cleaned = cleaned.replace(token, "")
    cleaned = cleaned.strip(" ，,。.")
    return cleaned or fallback
