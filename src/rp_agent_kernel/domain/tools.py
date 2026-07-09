from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..models import (
    ActionRecord,
    CalendarEventCreate,
    CalendarEventPatch,
    ConfirmationRecord,
    FeatureName,
    MessageRequest,
    ReminderCreate,
    ReminderPatch,
    TaskCreate,
    TaskPatch,
)
from .planner import Plan, PlannedOperation
from ..storage import Storage


@dataclass
class ExecutionResult:
    actions: list[ActionRecord] = field(default_factory=list)
    confirmations: list[ConfirmationRecord] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)


class ToolExecutor:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def execute(self, session_id: str, request: MessageRequest, plan: Plan) -> ExecutionResult:
        result = ExecutionResult()
        for operation in plan.operations:
            if operation.op_type == "noop":
                continue
            if operation.feature is not None:
                feature = FeatureName(operation.feature)
                if not self.storage.is_enabled(feature):
                    result.actions.append(
                        self.storage.add_action(
                            action_type=operation.op_type,
                            status="feature_disabled",
                            feature=feature,
                            payload={"reason": f"{feature.value} is disabled"},
                        )
                    )
                    continue
            if operation.requires_confirmation and self.storage.is_enabled(FeatureName.confirmation_safety):
                confirmation = self.storage.add_confirmation(
                    action_type=operation.op_type,
                    reason=operation.reason or "该操作需要确认。",
                    payload=operation.payload,
                )
                result.confirmations.append(confirmation)
                result.actions.append(
                    self.storage.add_action(
                        action_type=operation.op_type,
                        status="confirmation_required",
                        feature=FeatureName(operation.feature) if operation.feature else None,
                        payload={"confirmationId": confirmation.id, **operation.payload},
                    )
                )
                continue
            self._execute_operation(session_id, request, operation, result)
        return result

    def execute_confirmation(self, confirmation_id: str, decision: str) -> ExecutionResult:
        confirmation = self.storage.get_confirmation(confirmation_id)
        decided = self.storage.decide_confirmation(confirmation_id, decision)
        result = ExecutionResult(confirmations=[decided])
        if decision == "rejected":
            result.actions.append(
                self.storage.add_action(
                    action_type=confirmation.action_type,
                    status="rejected",
                    feature=None,
                    payload={"confirmationId": confirmation_id},
                )
            )
            return result

        operation = PlannedOperation(
            op_type=confirmation.action_type,
            payload=confirmation.payload,
            requires_confirmation=False,
        )
        self._execute_unsafe_confirmation(operation, result, confirmation_id)
        return result

    def _execute_operation(
        self,
        session_id: str,
        request: MessageRequest,
        operation: PlannedOperation,
        result: ExecutionResult,
    ) -> None:
        if operation.op_type == "create_calendar":
            event = self.storage.create_event(CalendarEventCreate.model_validate(operation.payload))
            result.artifacts.setdefault("calendarEvents", []).append(event)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.calendar,
                    payload={"eventId": event.id, "title": event.title, "start": event.start.isoformat()},
                )
            )
        elif operation.op_type == "list_calendar":
            start = datetime.fromisoformat(operation.payload["start"])
            end = datetime.fromisoformat(operation.payload["end"])
            events = self.storage.list_events(start, end)
            result.artifacts["calendarEvents"] = events
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.calendar,
                    payload={"count": len(events), "start": start.isoformat(), "end": end.isoformat()},
                )
            )
        elif operation.op_type == "create_task":
            payload = _with_origin_metadata(operation.payload, session_id, request)
            task = self.storage.create_task(TaskCreate.model_validate(payload))
            result.artifacts.setdefault("tasks", []).append(task)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.tasks,
                    payload={"taskId": task.id, "title": task.title},
                )
            )
        elif operation.op_type == "list_tasks":
            tasks = self.storage.list_tasks()
            result.artifacts["tasks"] = tasks
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.tasks,
                    payload={"count": len(tasks)},
                )
            )
        elif operation.op_type == "delete_task":
            self._delete_task(operation, result)
        elif operation.op_type == "create_reminder":
            payload = _with_origin_metadata(operation.payload, session_id, request)
            reminder = self.storage.create_reminder(ReminderCreate.model_validate(payload))
            result.artifacts.setdefault("reminders", []).append(reminder)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.reminders,
                    payload={
                        "reminderId": reminder.id,
                        "title": reminder.title,
                        "remindAt": reminder.remind_at.isoformat(),
                    },
                )
            )
        elif operation.op_type == "delete_reminder":
            self._delete_reminder(operation, result)
        elif operation.op_type == "update_reminder":
            self._update_reminder(operation, result)
        elif operation.op_type == "write_rp_memory":
            memory = self.storage.add_memory(
                mode="rp",
                session_id=session_id,
                character_id=request.character_id,
                content=operation.payload["content"],
                tags=operation.payload.get("tags", []),
            )
            result.artifacts.setdefault("memories", []).append(memory)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.rp_memory,
                    payload={"memoryId": memory.id},
                )
            )
        elif operation.op_type == "write_secretary_memory":
            memory = self.storage.add_memory(
                mode="sms",
                session_id=session_id,
                character_id=None,
                content=operation.payload["content"],
                tags=operation.payload.get("tags", []),
            )
            result.artifacts.setdefault("memories", []).append(memory)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.secretary_memory,
                    payload={"memoryId": memory.id},
                )
            )
        elif operation.op_type == "delete_calendar":
            self._delete_calendar(operation, result)
        elif operation.op_type in {
            "bulk_delete_calendar",
            "reschedule_calendar",
            "delete_calendar",
            "delete_reminder",
            "delete_task",
            "update_reminder",
        }:
            self._execute_unsafe_confirmation(operation, result, None)

    def _execute_unsafe_confirmation(
        self, operation: PlannedOperation, result: ExecutionResult, confirmation_id: str | None
    ) -> None:
        if operation.op_type == "bulk_delete_calendar":
            deleted = self.storage.delete_all_events()
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="completed",
                    feature=FeatureName.calendar,
                    payload={"deleted": deleted, "confirmationId": confirmation_id},
                )
            )
        elif operation.op_type == "reschedule_calendar":
            updated = self._reschedule_calendar(operation, result, confirmation_id)
            if updated:
                return
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="approved_no_target",
                    feature=FeatureName.calendar,
                    payload={"confirmationId": confirmation_id, **operation.payload},
                )
            )
        elif operation.op_type == "delete_calendar":
            self._delete_calendar(operation, result, confirmation_id=confirmation_id)
        elif operation.op_type == "delete_reminder":
            self._delete_reminder(operation, result, confirmation_id=confirmation_id)
        elif operation.op_type == "delete_task":
            self._delete_task(operation, result, confirmation_id=confirmation_id)
        elif operation.op_type == "update_reminder":
            self._update_reminder(operation, result, confirmation_id=confirmation_id)

    def _delete_calendar(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        *,
        confirmation_id: str | None = None,
    ) -> None:
        matches = _calendar_matches(
            self.storage.list_events(),
            operation.payload.get("query", ""),
            operation.payload.get("targetTime"),
            operation.payload.get("targetIds"),
        )
        if not self._require_target_confirmation(operation, result, matches, FeatureName.calendar):
            return
        if not matches:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.calendar, "未找到匹配日程。"))
            return
        for event in matches:
            self.storage.delete_event(event.id)
        result.artifacts.setdefault("calendarEvents", []).extend(matches)
        result.actions.append(
            self.storage.add_action(
                action_type=operation.op_type,
                status="completed",
                feature=FeatureName.calendar,
                payload={
                    "eventId": matches[0].id,
                    "title": matches[0].title,
                    "deleted": len(matches),
                    "confirmationId": confirmation_id,
                },
            )
        )

    def _delete_reminder(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        *,
        confirmation_id: str | None = None,
    ) -> None:
        matches = _reminder_matches(
            self.storage.list_reminders(),
            operation.payload.get("query", ""),
            operation.payload.get("targetTime"),
            operation.payload.get("targetIds"),
        )
        if not self._require_target_confirmation(operation, result, matches, FeatureName.reminders):
            return
        if not matches:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.reminders, "未找到匹配提醒。"))
            return
        for reminder in matches:
            self.storage.delete_reminder(reminder.id)
        result.artifacts.setdefault("reminders", []).extend(matches)
        result.actions.append(
            self.storage.add_action(
                action_type=operation.op_type,
                status="completed",
                feature=FeatureName.reminders,
                payload={
                    "reminderId": matches[0].id,
                    "title": matches[0].title,
                    "deleted": len(matches),
                    "confirmationId": confirmation_id,
                },
            )
        )

    def _delete_task(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        *,
        confirmation_id: str | None = None,
    ) -> None:
        matches = _task_matches(
            self.storage.list_tasks(),
            operation.payload.get("query", ""),
            operation.payload.get("targetTime"),
            operation.payload.get("targetIds"),
        )
        if not self._require_target_confirmation(operation, result, matches, FeatureName.tasks):
            return
        if not matches:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.tasks, "未找到匹配任务。"))
            return
        for task in matches:
            self.storage.delete_task(task.id)
        result.artifacts.setdefault("tasks", []).extend(matches)
        result.actions.append(
            self.storage.add_action(
                action_type=operation.op_type,
                status="completed",
                feature=FeatureName.tasks,
                payload={
                    "taskId": matches[0].id,
                    "title": matches[0].title,
                    "deleted": len(matches),
                    "confirmationId": confirmation_id,
                },
            )
        )

    def _update_reminder(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        *,
        confirmation_id: str | None = None,
    ) -> None:
        target_time = operation.payload.get("targetTime")
        if not target_time:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.reminders, "缺少新的提醒时间。"))
            return
        matches = _reminder_matches(
            self.storage.list_reminders(),
            operation.payload.get("query", ""),
            None,
            operation.payload.get("targetIds"),
        )
        if not self._require_target_confirmation(operation, result, matches, FeatureName.reminders):
            return
        if not matches:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.reminders, "未找到匹配提醒。"))
            return
        reminder = self.storage.patch_reminder(
            matches[0].id,
            ReminderPatch(remindAt=datetime.fromisoformat(target_time), status="scheduled"),
        )
        result.artifacts.setdefault("reminders", []).append(reminder)
        result.actions.append(
            self.storage.add_action(
                action_type=operation.op_type,
                status="completed",
                feature=FeatureName.reminders,
                payload={
                    "reminderId": reminder.id,
                    "title": reminder.title,
                    "remindAt": reminder.remind_at.isoformat(),
                    "confirmationId": confirmation_id,
                },
            )
        )

    def _reschedule_calendar(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        confirmation_id: str | None,
    ) -> bool:
        target_time = operation.payload.get("targetTime")
        if not target_time:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.calendar, "缺少新的日程时间。"))
            return True
        matches = _calendar_matches(
            self.storage.list_events(),
            operation.payload.get("query", ""),
            None,
            operation.payload.get("targetIds"),
        )
        if not matches:
            result.actions.append(_failed_action(self.storage, operation, FeatureName.calendar, "未找到匹配日程。"))
            return True
        if len(matches) > 1 and not operation.payload.get("targetIds"):
            result.actions.append(_failed_action(self.storage, operation, FeatureName.calendar, "匹配到多条日程，请说得更具体。"))
            return True
        current = matches[0]
        start = datetime.fromisoformat(target_time)
        duration = (current.end - current.start) if current.end else None
        updated = self.storage.patch_event(
            current.id,
            CalendarEventPatch(start=start, end=start + duration if duration else None),
        )
        result.artifacts.setdefault("calendarEvents", []).append(updated)
        result.actions.append(
            self.storage.add_action(
                action_type=operation.op_type,
                status="completed",
                feature=FeatureName.calendar,
                payload={
                    "eventId": updated.id,
                    "title": updated.title,
                    "start": updated.start.isoformat(),
                    "confirmationId": confirmation_id,
                },
            )
        )
        return True

    def _require_target_confirmation(
        self,
        operation: PlannedOperation,
        result: ExecutionResult,
        matches: list[Any],
        feature: FeatureName,
    ) -> bool:
        if len(matches) <= 1 or operation.payload.get("targetIds"):
            return True
        if self.storage.is_enabled(FeatureName.confirmation_safety):
            confirmation = self.storage.add_confirmation(
                action_type=operation.op_type,
                reason=f"匹配到 {len(matches)} 条记录，请确认是否全部处理。",
                payload={
                    **operation.payload,
                    "targetIds": [item.id for item in matches],
                    "matchedTitles": [getattr(item, "title", item.id) for item in matches],
                },
            )
            result.confirmations.append(confirmation)
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="confirmation_required",
                    feature=feature,
                    payload={"confirmationId": confirmation.id, "count": len(matches)},
                )
            )
            return False
        return True


def _with_origin_metadata(
    payload: dict[str, Any], session_id: str, request: MessageRequest
) -> dict[str, Any]:
    metadata = {
        **(payload.get("metadata") or {}),
        "sessionId": session_id,
        "mode": request.mode,
        "characterId": request.character_id,
        "source": "planner",
    }
    return {**payload, "metadata": metadata}


def _failed_action(
    storage: Storage,
    operation: PlannedOperation,
    feature: FeatureName,
    reason: str,
) -> ActionRecord:
    return storage.add_action(
        action_type=operation.op_type,
        status="failed",
        feature=feature,
        payload={"reason": reason, **operation.payload},
    )


def _calendar_matches(events: list[Any], query: str, target_time: str | None, target_ids: list[str] | None = None) -> list[Any]:
    return _rank_matches(events, query, target_time, "start", target_ids)


def _reminder_matches(reminders: list[Any], query: str, target_time: str | None, target_ids: list[str] | None = None) -> list[Any]:
    return _rank_matches(reminders, query, target_time, "remind_at", target_ids)


def _task_matches(tasks: list[Any], query: str, target_time: str | None, target_ids: list[str] | None = None) -> list[Any]:
    return _rank_matches(tasks, query, target_time, "due_at", target_ids)


def _rank_matches(
    items: list[Any],
    query: str,
    target_time: str | None,
    time_attr: str,
    target_ids: list[str] | None = None,
) -> list[Any]:
    if target_ids:
        wanted = set(target_ids)
        return [item for item in items if item.id in wanted]
    normalized_query = _normalize_query(query)
    parsed_time = datetime.fromisoformat(target_time) if target_time else None
    scored: list[tuple[int, Any]] = []
    for item in items:
        score = 0
        if normalized_query:
            title = _normalize_query(getattr(item, "title", ""))
            if normalized_query in title or title in normalized_query:
                score += 4
            elif all(part in title for part in normalized_query.split() if part):
                score += 2
        item_time = getattr(item, time_attr, None)
        if parsed_time is not None and item_time is not None:
            delta = abs((item_time - parsed_time).total_seconds())
            if delta <= 60:
                score += 5
            elif delta <= 3600:
                score += 3
            elif item_time.date() == parsed_time.date():
                score += 1
        if score > 0 or (not normalized_query and parsed_time is None and len(items) == 1):
            scored.append((score, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    if not scored:
        return []
    top_score = scored[0][0]
    return [item for score, item in scored if score == top_score]


def _normalize_query(value: str) -> str:
    return " ".join(str(value or "").lower().strip().split())
