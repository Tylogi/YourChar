from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .models import (
    ActionRecord,
    CalendarEventCreate,
    ConfirmationRecord,
    FeatureName,
    MessageRequest,
    ReminderCreate,
    TaskCreate,
)
from .planner import Plan, PlannedOperation
from .storage import Storage


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
            task = self.storage.create_task(TaskCreate.model_validate(operation.payload))
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
        elif operation.op_type == "create_reminder":
            reminder = self.storage.create_reminder(ReminderCreate.model_validate(operation.payload))
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
        elif operation.op_type in {"bulk_delete_calendar", "reschedule_calendar"}:
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
            result.actions.append(
                self.storage.add_action(
                    action_type=operation.op_type,
                    status="approved_no_target",
                    feature=FeatureName.calendar,
                    payload={"confirmationId": confirmation_id, **operation.payload},
                )
            )
