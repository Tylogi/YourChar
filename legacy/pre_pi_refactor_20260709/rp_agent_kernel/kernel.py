from __future__ import annotations

import re
import statistics
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .context import ContextBuilder
from .external_model import ExternalModelError, ExternalModelStreamState, OpenAICompatibleClient
from .models import (
    CapabilityReport,
    ConfirmationDecision,
    EventDelivery,
    EventDeliveryPatch,
    EvalCaseResult,
    EvalRunRequest,
    EvalRunResponse,
    FeatureName,
    MessageMetrics,
    MessageRequest,
    MessageResponse,
    SharedEpisodeCreate,
)
from .planner import Planner
from .renderer import Renderer
from .storage import Storage
from .tools import ToolExecutor


@dataclass(frozen=True)
class PreparedMessage:
    context: Any
    execution: Any
    fallback_reply: str
    planner_ms: float
    context_ms: float
    tool_ms: float


class Kernel:
    def __init__(self, db_path: str | Path = "rp_agent_kernel.sqlite3") -> None:
        self.storage = Storage(db_path)
        self.planner = Planner()
        self.context_builder = ContextBuilder(self.storage)
        self.executor = ToolExecutor(self.storage)
        self.renderer = Renderer()
        self.external_model = OpenAICompatibleClient()

    def close(self) -> None:
        self.storage.close()

    def handle_message(self, session_id: str, request: MessageRequest) -> MessageResponse:
        total_start = time.perf_counter()
        prepared = self._prepare_message(session_id, request)

        renderer_start = time.perf_counter()
        reply = self._render_with_optional_external_model(
            session_id=session_id,
            request=request,
            execution=prepared.execution,
            fallback_reply=prepared.fallback_reply,
        )
        renderer_ms = _elapsed_ms(renderer_start)

        metrics = self._build_metrics(
            total_start=total_start,
            prepared=prepared,
            renderer_ms=renderer_ms,
            generated_text=reply,
        )
        return self._finalize_message(
            session_id=session_id,
            request=request,
            reply=reply,
            prepared=prepared,
            metrics=metrics,
        )

    def stream_message_events(
        self, session_id: str, request: MessageRequest
    ) -> Iterator[dict[str, Any]]:
        total_start = time.perf_counter()
        prepared = self._prepare_message(session_id, request)
        context_budget = self._context_budget()
        yield {
            "type": "start",
            "contextTraceId": prepared.context.trace_id,
            "metrics": {
                "tokenEstimate": prepared.context.token_estimate,
                "contextWindowTokens": context_budget,
                "contextUsageRatio": _safe_ratio(prepared.context.token_estimate, context_budget),
            },
        }

        renderer_start = time.perf_counter()
        reply = ""
        stream_stats: dict[str, Any] = {
            "prefill_ms": None,
            "prefill_tokens": prepared.context.token_estimate,
            "prefill_tokens_per_second": None,
            "generated_tokens": 0,
            "generation_tokens_per_second": None,
        }
        try:
            for delta in self._stream_reply(
                session_id=session_id,
                request=request,
                prepared=prepared,
                renderer_start=renderer_start,
                stream_stats=stream_stats,
            ):
                reply += delta
                yield {
                    "type": "delta",
                    "text": delta,
                    "metrics": self._live_stream_metrics(
                        total_start=total_start,
                        prepared=prepared,
                        stream_stats=stream_stats,
                    ),
                }
        except ExternalModelError as exc:
            prepared.execution.actions.append(
                self.storage.add_action(
                    action_type="external_model_render",
                    status="failed",
                    feature=FeatureName.external_model,
                    payload={"fallback": not bool(reply), "error": str(exc)},
                )
            )
            if not reply:
                reply = prepared.fallback_reply
                self._record_fallback_stream_stats(renderer_start, reply, stream_stats)
                yield {"type": "status", "status": "fallback", "detail": str(exc)}
                yield {
                    "type": "delta",
                    "text": reply,
                    "metrics": self._live_stream_metrics(
                        total_start=total_start,
                        prepared=prepared,
                        stream_stats=stream_stats,
                    ),
                }
            else:
                yield {"type": "status", "status": "partial_error", "detail": str(exc)}

        renderer_ms = _elapsed_ms(renderer_start)
        metrics = self._build_metrics(
            total_start=total_start,
            prepared=prepared,
            renderer_ms=renderer_ms,
            stream_stats=stream_stats,
            generated_text=reply,
        )
        response = self._finalize_message(
            session_id=session_id,
            request=request,
            reply=reply,
            prepared=prepared,
            metrics=metrics,
        )
        yield {"type": "done", "response": response.model_dump(mode="json", by_alias=True)}

    def _prepare_message(self, session_id: str, request: MessageRequest) -> PreparedMessage:
        planner_start = time.perf_counter()
        plan = self.planner.plan(request)
        planner_ms = _elapsed_ms(planner_start)

        context_start = time.perf_counter()
        context = self.context_builder.build(session_id, request)
        context_ms = _elapsed_ms(context_start)

        tool_start = time.perf_counter()
        execution = self.executor.execute(session_id, request, plan)
        tool_ms = _elapsed_ms(tool_start)
        fallback_reply = self.renderer.render(
            request, execution, storage=self.storage, session_id=session_id
        )
        return PreparedMessage(
            context=context,
            execution=execution,
            fallback_reply=fallback_reply,
            planner_ms=planner_ms,
            context_ms=context_ms,
            tool_ms=tool_ms,
        )

    def _finalize_message(
        self,
        *,
        session_id: str,
        request: MessageRequest,
        reply: str,
        prepared: PreparedMessage,
        metrics: MessageMetrics | None,
    ) -> MessageResponse:
        self.storage.add_message(
            session_id=session_id,
            mode=request.mode,
            role="user",
            content=request.text,
            character_id=request.character_id,
        )
        self.storage.add_message(
            session_id=session_id,
            mode=request.mode,
            role="assistant",
            content=reply,
            character_id=request.character_id,
        )
        self._record_shared_episode(session_id, request, reply, prepared)

        return MessageResponse(
            reply=reply,
            actions=prepared.execution.actions,
            confirmations=prepared.execution.confirmations,
            contextTraceId=prepared.context.trace_id,
            metrics=metrics,
        )

    def _record_shared_episode(
        self,
        session_id: str,
        request: MessageRequest,
        reply: str,
        prepared: PreparedMessage,
    ) -> None:
        if request.mode != "rp" or not self.storage.is_enabled(FeatureName.shared_timeline):
            return
        text = request.text.strip()
        if not text or not _should_record_shared_episode(text):
            return
        occurred_at = request.now or datetime.now().astimezone()
        character_name = ""
        if request.character_id:
            try:
                character_name = self.storage.get_character(request.character_id).name
            except KeyError:
                character_name = ""
        companion = character_name or "我"
        summary = f"你和{companion}在这段场景里共同经历了：{_compact_episode_text(text)}"
        interpretation = "这会影响之后的熟悉感、等待感和语气，但不会自动变成真实日程或任务。"
        episode = self.storage.add_shared_episode(
            SharedEpisodeCreate(
                sessionId=session_id,
                mode="rp",
                characterId=request.character_id,
                summary=summary,
                characterInterpretation=interpretation,
                relationshipDelta={},
                realityScope="shared_experience",
                usableForRealWorldTools=False,
                metadata={
                    "source": "rp_message",
                    "assistantReplyPreview": _compact_episode_text(reply, limit=80),
                },
                occurredAt=occurred_at,
            )
        )
        prepared.execution.artifacts.setdefault("sharedEpisodes", []).append(episode)
        prepared.execution.actions.append(
            self.storage.add_action(
                action_type="record_shared_episode",
                status="completed",
                feature=FeatureName.shared_timeline,
                payload={
                    "episodeId": episode.id,
                    "sessionId": session_id,
                    "characterId": request.character_id,
                    "usableForRealWorldTools": False,
                },
            )
        )

    def _stream_reply(
        self,
        *,
        session_id: str,
        request: MessageRequest,
        prepared: PreparedMessage,
        renderer_start: float,
        stream_stats: dict[str, Any],
    ) -> Iterator[str]:
        config = self.storage.get_raw_openai_config()
        if not config.get("enabled"):
            self._record_fallback_stream_stats(renderer_start, prepared.fallback_reply, stream_stats)
            yield prepared.fallback_reply
            return

        if not self.storage.is_enabled(FeatureName.external_model):
            prepared.execution.actions.append(
                self.storage.add_action(
                    action_type="external_model_render",
                    status="feature_disabled",
                    feature=FeatureName.external_model,
                    payload={"fallback": True},
                )
            )
            self._record_fallback_stream_stats(renderer_start, prepared.fallback_reply, stream_stats)
            yield prepared.fallback_reply
            return

        state = ExternalModelStreamState()
        first_delta_at: float | None = None
        generation_start: float | None = None
        for delta in self.external_model.stream_render(
            storage=self.storage,
            session_id=session_id,
            request=request,
            execution=prepared.execution,
            config=config,
            state=state,
            fallback_reply=prepared.fallback_reply,
        ):
            now = time.perf_counter()
            if first_delta_at is None:
                first_delta_at = now
                generation_start = now
                prefill_ms = _elapsed_ms(renderer_start)
                stream_stats["prefill_ms"] = prefill_ms
                stream_stats["prefill_tokens_per_second"] = _rate(
                    prepared.context.token_estimate, prefill_ms
                )
            generated_tokens = _estimate_tokens(state.content)
            stream_stats["generated_tokens"] = generated_tokens
            if generation_start is not None:
                stream_stats["generation_tokens_per_second"] = _rate(
                    generated_tokens, (now - generation_start) * 1000
                )
            yield delta

        if not state.content:
            raise ExternalModelError("external model returned empty stream")

        _apply_usage_to_stream_stats(state.usage, stream_stats)
        prepared.execution.actions.append(
            self.storage.add_action(
                action_type="external_model_render",
                status="completed",
                feature=FeatureName.external_model,
                payload={
                    "model": state.model or config.get("model") or "",
                    "usage": state.usage,
                    "modelCallLogId": state.log_id,
                    "fallback": False,
                    "stream": True,
                },
            )
        )

    def _record_fallback_stream_stats(
        self, renderer_start: float, reply: str, stream_stats: dict[str, Any]
    ) -> None:
        prefill_ms = _elapsed_ms(renderer_start)
        stream_stats["prefill_ms"] = prefill_ms
        stream_stats["prefill_tokens_per_second"] = None
        stream_stats["generated_tokens"] = _estimate_tokens(reply)
        stream_stats["generation_tokens_per_second"] = None

    def _build_metrics(
        self,
        *,
        total_start: float,
        prepared: PreparedMessage,
        renderer_ms: float,
        stream_stats: dict[str, Any] | None = None,
        generated_text: str = "",
    ) -> MessageMetrics | None:
        if not self.storage.is_enabled(FeatureName.metrics):
            return None
        context_budget = self._context_budget()
        generated_tokens = None
        if generated_text:
            generated_tokens = _estimate_tokens(generated_text)
        if stream_stats and stream_stats.get("generated_tokens"):
            generated_tokens = int(stream_stats["generated_tokens"])
        return MessageMetrics(
            latencyMs=_elapsed_ms(total_start),
            plannerMs=prepared.planner_ms,
            contextMs=prepared.context_ms,
            toolMs=prepared.tool_ms,
            rendererMs=renderer_ms,
            tokenEstimate=prepared.context.token_estimate,
            contextWindowTokens=context_budget,
            contextUsageRatio=_safe_ratio(prepared.context.token_estimate, context_budget),
            prefillMs=stream_stats.get("prefill_ms") if stream_stats else None,
            prefillTokens=stream_stats.get("prefill_tokens") if stream_stats else None,
            prefillTokensPerSecond=stream_stats.get("prefill_tokens_per_second") if stream_stats else None,
            generatedTokens=generated_tokens,
            generationTokensPerSecond=(
                stream_stats.get("generation_tokens_per_second") if stream_stats else None
            ),
            actionCount=len(prepared.execution.actions),
            featureFlags=self.storage.feature_flags_json(),
        )

    def _live_stream_metrics(
        self,
        *,
        total_start: float,
        prepared: PreparedMessage,
        stream_stats: dict[str, Any],
    ) -> dict[str, Any]:
        context_budget = self._context_budget()
        return {
            "latencyMs": _elapsed_ms(total_start),
            "tokenEstimate": prepared.context.token_estimate,
            "contextWindowTokens": context_budget,
            "contextUsageRatio": _safe_ratio(prepared.context.token_estimate, context_budget),
            "prefillMs": stream_stats.get("prefill_ms"),
            "prefillTokens": stream_stats.get("prefill_tokens"),
            "prefillTokensPerSecond": stream_stats.get("prefill_tokens_per_second"),
            "generatedTokens": stream_stats.get("generated_tokens"),
            "generationTokensPerSecond": stream_stats.get("generation_tokens_per_second"),
        }

    def _context_budget(self) -> int:
        raw = self.storage.get_raw_openai_config().get("context_window_tokens") or 128000
        return max(1, int(raw))

    def confirm_action(self, confirmation_id: str, decision: ConfirmationDecision) -> MessageResponse:
        start = time.perf_counter()
        execution = self.executor.execute_confirmation(confirmation_id, decision.decision)
        reply = self.renderer._render_sms(execution)
        metrics = None
        if self.storage.is_enabled(FeatureName.metrics):
            metrics = MessageMetrics(
                latencyMs=_elapsed_ms(start),
                plannerMs=0,
                contextMs=0,
                toolMs=_elapsed_ms(start),
                rendererMs=0,
                tokenEstimate=0,
                actionCount=len(execution.actions),
                featureFlags=self.storage.feature_flags_json(),
            )
        return MessageResponse(
            reply=reply,
            actions=execution.actions,
            confirmations=execution.confirmations,
            contextTraceId=None,
            metrics=metrics,
        )

    def due_events(
        self,
        now: datetime | None = None,
        *,
        include_pending: bool = False,
        client_id: str = "kernel",
        lease_seconds: int = 60,
        claim_new: bool = True,
    ) -> list[dict[str, Any]]:
        due_at = now or datetime.now().astimezone()
        deliveries: list[EventDelivery] = []
        for reminder in self.storage.due_reminders(due_at):
            event = self._reminder_due_event(reminder)
            deliveries.append(
                self.storage.add_event_delivery(
                    event_type=event["type"],
                    resource_id=reminder.id,
                    payload=event,
                )
            )
        for task in self.storage.due_tasks(due_at):
            event = self._task_overdue_event(task)
            deliveries.append(
                self.storage.add_event_delivery(
                    event_type=event["type"],
                    resource_id=task.id,
                    payload=event,
                )
            )
        if include_pending:
            deliveries = self.storage.claim_event_deliveries(
                client_id=client_id, lease_seconds=lease_seconds, now=due_at
            )
        elif deliveries and claim_new:
            deliveries = self.storage.claim_event_deliveries(
                client_id=client_id,
                lease_seconds=lease_seconds,
                now=due_at,
                delivery_ids=[delivery.id for delivery in deliveries],
            )
        return [self._event_delivery_payload(delivery) for delivery in deliveries]

    def pending_events(self) -> list[dict[str, Any]]:
        deliveries = self.storage.list_event_deliveries(
            statuses=("pending", "claimed", "failed")
        )
        return [self._event_delivery_payload(delivery) for delivery in deliveries]

    def update_event_delivery(
        self, delivery_id: str, patch: EventDeliveryPatch
    ) -> EventDelivery:
        return self.storage.patch_event_delivery(delivery_id, patch)

    def _event_delivery_payload(self, delivery: EventDelivery) -> dict[str, Any]:
        payload = dict(delivery.payload)
        payload["delivery"] = {
            "id": delivery.id,
            "eventType": delivery.event_type,
            "resourceId": delivery.resource_id,
            "status": delivery.status,
            "attempts": delivery.attempts,
            "createdAt": delivery.created_at.isoformat(),
            "updatedAt": delivery.updated_at.isoformat(),
            "acknowledgedAt": (
                delivery.acknowledged_at.isoformat() if delivery.acknowledged_at else None
            ),
            "lastError": delivery.last_error,
            "claimedBy": delivery.claimed_by,
            "claimExpiresAt": (
                delivery.claim_expires_at.isoformat() if delivery.claim_expires_at else None
            ),
        }
        payload["eventDeliveryId"] = delivery.id
        return payload

    def _reminder_due_event(self, reminder) -> dict[str, Any]:
        origin = _origin_from_metadata(reminder.metadata)
        message = self._render_proactive_message(
            kind="reminder",
            title=reminder.title,
            due_at=reminder.remind_at,
            origin=origin,
        )
        action = self.storage.add_action(
            action_type="reminder_due",
            status="completed",
            feature=FeatureName.reminders,
            payload={
                "reminderId": reminder.id,
                "title": reminder.title,
                "remindAt": reminder.remind_at.isoformat(),
                "sessionId": origin["sessionId"],
                "mode": origin["mode"],
                "characterId": origin["characterId"],
                "message": message,
            },
        )
        memory = self._write_proactive_memory(
            origin,
            f"主动提醒已触发：{reminder.title} @ {reminder.remind_at.isoformat()}",
            ["proactive", "reminder"],
        )
        return {
            "type": "ReminderDue",
            "mode": origin["mode"],
            "sessionId": origin["sessionId"],
            "characterId": origin["characterId"],
            "message": message,
            "memoryPolicy": _proactive_memory_policy(origin),
            "reminder": reminder.model_dump(mode="json", by_alias=True),
            "action": action.model_dump(mode="json", by_alias=True),
            "memory": memory.model_dump(mode="json", by_alias=True) if memory else None,
        }

    def _task_overdue_event(self, task) -> dict[str, Any]:
        origin = _origin_from_metadata(task.metadata)
        message = self._render_proactive_message(
            kind="task",
            title=task.title,
            due_at=task.due_at,
            origin=origin,
        )
        action = self.storage.add_action(
            action_type="task_overdue",
            status="completed",
            feature=FeatureName.tasks,
            payload={
                "taskId": task.id,
                "title": task.title,
                "dueAt": task.due_at.isoformat() if task.due_at else None,
                "sessionId": origin["sessionId"],
                "mode": origin["mode"],
                "characterId": origin["characterId"],
                "message": message,
            },
        )
        memory = self._write_proactive_memory(
            origin,
            f"主动任务事件已触发：{task.title} @ {task.due_at.isoformat() if task.due_at else 'no due time'}",
            ["proactive", "task"],
        )
        return {
            "type": "TaskOverdue",
            "mode": origin["mode"],
            "sessionId": origin["sessionId"],
            "characterId": origin["characterId"],
            "message": message,
            "memoryPolicy": _proactive_memory_policy(origin),
            "task": task.model_dump(mode="json", by_alias=True),
            "action": action.model_dump(mode="json", by_alias=True),
            "memory": memory.model_dump(mode="json", by_alias=True) if memory else None,
        }

    def _render_proactive_message(
        self,
        *,
        kind: str,
        title: str,
        due_at: datetime | None,
        origin: dict[str, str | None],
    ) -> str:
        due_text = due_at.strftime("%Y-%m-%d %H:%M") if due_at else "现在"
        label = "提醒" if kind == "reminder" else "任务"
        if origin["mode"] != "rp":
            if kind == "task":
                return f"我来提醒你：任务已逾期，{title}。时间 {due_text}。"
            return f"我来提醒你：{title}。时间 {due_text}。"

        character_name = ""
        persona = ""
        scenario = ""
        if origin["characterId"]:
            try:
                character = self.storage.get_character(origin["characterId"])
                character_name = character.name
                persona = character.persona
                scenario = character.scenario
            except KeyError:
                character_name = ""
        speaker = character_name or "她"
        voice = _rp_voice_phrase(persona, scenario)
        return (
            f"{speaker}{voice}没有打断场景，只把一张便签推到你手边："
            f"现实{label}到了，{title}。时间 {due_text}。"
            "处理完，我们再回到刚才的叙事。"
        )

    def _write_proactive_memory(
        self, origin: dict[str, str | None], content: str, tags: list[str]
    ):
        if origin["mode"] == "rp":
            if not self.storage.is_enabled(FeatureName.rp_memory):
                return None
            return self.storage.add_memory(
                mode="rp",
                session_id=origin["sessionId"] or "events",
                character_id=origin["characterId"],
                content=f"现实提醒触发（不作为剧情事实）：{content}",
                tags=[*tags, "real_world", "out_of_character"],
                source="proactive_event",
            )
        if not self.storage.is_enabled(FeatureName.secretary_memory):
            return None
        return self.storage.add_memory(
            mode="sms",
            session_id=origin["sessionId"] or "events",
            character_id=None,
            content=content,
            tags=tags,
            source="proactive_event",
        )

    def capabilities(self) -> CapabilityReport:
        return CapabilityReport(
            modes=["sms", "rp"],
            features=self.storage.feature_records(),
            endpoints=[
                "POST /api/sessions/{id}/messages",
                "POST /api/sessions/{id}/messages/stream",
                "GET /api/sessions",
                "GET/DELETE /api/sessions/{id}/messages",
                "POST /api/sessions/{id}/clone",
                "GET /api/events/stream",
                "GET /api/events/poll",
                "GET /api/events/pending",
                "POST /api/runtime/tick",
                "POST /api/events/{deliveryId}/delivery",
                "GET/POST/PATCH/DELETE /api/calendar/events",
                "GET/POST/PATCH/DELETE /api/tasks",
                "GET/POST/PATCH/DELETE /api/reminders",
                "GET/POST/PATCH/DELETE /api/characters",
                "POST /api/characters/import-card",
                "GET/PATCH /api/model-config/openai-compatible",
                "GET /api/model-config/openai-compatible/models",
                "GET/DELETE /api/model-call-logs",
                "GET/PATCH /api/features",
                "GET/PATCH /api/companion-profile",
                "GET/PATCH /api/debug/time",
                "GET /api/context-traces/{id}",
                "GET /api/shared-timeline",
                "POST /api/confirmations/{id}",
                "GET /api/eval/capabilities",
                "POST /api/eval/run",
            ],
            sdkMethods=[
                "sendMessage(sessionId, mode, text)",
                "subscribeEvents(handler)",
                "ackEvent(deliveryId)",
                "listSchedule(range)",
                "confirmAction(actionId, decision)",
                "getFeatures()",
                "setFeature(name, enabled)",
                "getCompanionProfile()",
                "setCompanionProfile(profile)",
                "getDebugTime()",
                "setDebugTime(time)",
                "getOpenAICompatibleConfig()",
                "setOpenAICompatibleConfig(config)",
                "listOpenAICompatibleModels()",
                "importCharacterCard(file)",
                "runEval(cases)",
            ],
            promptLayout={
                "externalModel": "cache-friendly-v1",
                "messageOrder": [
                    "system:stable-render-contract",
                    "system:semi-stable-companion-and-character",
                    "history:recent-chat",
                    "user:dynamic-runtime-context-and-current-message",
                ],
                "dynamicContextRole": "user",
                "dynamicContextIncludes": [
                    "current_time",
                    "action_result_summary",
                    "retrieved_memory",
                    "shared_present",
                    "calendar",
                    "reminders",
                ],
                "reasoningFormats": [
                    "reasoning_content",
                    "reasoning",
                    "reasoningContent",
                    "think_tags",
                    "reasoning_tags",
                ],
            },
            agentTools={
                "calendar": [
                    "create_calendar",
                    "list_calendar",
                    "delete_calendar",
                    "reschedule_calendar",
                    "bulk_delete_calendar",
                ],
                "reminders": [
                    "create_reminder",
                    "delete_reminder",
                    "update_reminder",
                ],
                "tasks": [
                    "create_task",
                    "list_tasks",
                    "delete_task",
                ],
                "memory": [
                    "write_secretary_memory",
                    "write_rp_memory",
                ],
            },
            evalContractVersion="eval-contract-v1",
        )

    def _render_with_optional_external_model(
        self,
        *,
        session_id: str,
        request: MessageRequest,
        execution,
        fallback_reply: str,
    ) -> str:
        config = self.storage.get_raw_openai_config()
        if not config.get("enabled"):
            return fallback_reply

        if not self.storage.is_enabled(FeatureName.external_model):
            execution.actions.append(
                self.storage.add_action(
                    action_type="external_model_render",
                    status="feature_disabled",
                    feature=FeatureName.external_model,
                    payload={"fallback": True},
                )
            )
            return fallback_reply

        try:
            result = self.external_model.render(
                storage=self.storage,
                session_id=session_id,
                request=request,
                execution=execution,
                config=config,
                fallback_reply=fallback_reply,
            )
        except ExternalModelError as exc:
            execution.actions.append(
                self.storage.add_action(
                    action_type="external_model_render",
                    status="failed",
                    feature=FeatureName.external_model,
                    payload={
                        "fallback": True,
                        "error": str(exc),
                        "model": config.get("model") or "",
                    },
                )
            )
            return fallback_reply

        execution.actions.append(
            self.storage.add_action(
                action_type="external_model_render",
                status="completed",
                feature=FeatureName.external_model,
                payload={
                    "model": result.model,
                    "usage": result.usage,
                    "modelCallLogId": result.log_id,
                    "fallback": False,
                },
            )
        )
        return result.content

    def run_eval(self, request: EvalRunRequest | dict[str, Any]) -> EvalRunResponse:
        if not isinstance(request, EvalRunRequest):
            request = EvalRunRequest.model_validate(request)
        kernel = self
        if request.isolate:
            kernel = Kernel(":memory:")
        try:
            _seed_kernel(kernel, request)
            results: list[EvalCaseResult] = []
            for repeat_index in range(request.repeat):
                for case in request.cases:
                    start = time.perf_counter()
                    response = kernel.handle_message(case.session_id, case.request)
                    latency = _elapsed_ms(start)
                    assertion_results = _run_assertions(response, case.assertions, latency)
                    results.append(
                        EvalCaseResult(
                            id=case.id,
                            repeatIndex=repeat_index,
                            response=response,
                            passed=all(assertion_results.values()) if assertion_results else True,
                            assertionResults=assertion_results,
                            latencyMs=latency,
                        )
                    )
            latencies = [result.latency_ms for result in results]
            token_estimates = [
                result.response.metrics.token_estimate
                for result in results
                if result.response.metrics is not None
            ]
            context_ratios = [
                result.response.metrics.context_usage_ratio
                for result in results
                if result.response.metrics is not None
            ]
            generated_tokens = [
                result.response.metrics.generated_tokens
                for result in results
                if result.response.metrics is not None
                and result.response.metrics.generated_tokens is not None
            ]
            summary: dict[str, Any] = {
                "total": len(results),
                "passed": sum(1 for result in results if result.passed),
                "failed": sum(1 for result in results if not result.passed),
                "meanLatencyMs": statistics.mean(latencies) if latencies else 0,
                "maxLatencyMs": max(latencies) if latencies else 0,
                "meanTokenEstimate": statistics.mean(token_estimates) if token_estimates else 0,
                "maxTokenEstimate": max(token_estimates) if token_estimates else 0,
                "meanContextUsageRatio": (
                    statistics.mean(context_ratios) if context_ratios else 0
                ),
                "maxContextUsageRatio": max(context_ratios) if context_ratios else 0,
                "totalGeneratedTokens": sum(generated_tokens),
                "cost": {
                    "status": "unknown",
                    "reason": "model token prices are not configured",
                    "inputTokens": sum(token_estimates),
                    "outputTokens": sum(generated_tokens),
                    "totalTokens": sum(token_estimates) + sum(generated_tokens),
                    "estimatedCostUsd": None,
                },
            }
            return EvalRunResponse(
                deterministic=True,
                featureFlags=kernel.storage.feature_flags_json(),
                results=results,
                summary=summary,
            )
        finally:
            if kernel is not self:
                kernel.close()


def _seed_kernel(kernel: Kernel, request: EvalRunRequest) -> None:
    if request.seed.feature_flags:
        kernel.storage.set_features(request.seed.feature_flags)
    for character in request.seed.characters:
        kernel.storage.create_character(character)
    for event in request.seed.calendar_events:
        kernel.storage.create_event(event)
    for task in request.seed.tasks:
        kernel.storage.create_task(task)
    for reminder in request.seed.reminders:
        kernel.storage.create_reminder(reminder)


def _origin_from_metadata(metadata: dict[str, Any]) -> dict[str, str | None]:
    mode = metadata.get("mode") if isinstance(metadata, dict) else None
    character_id = metadata.get("characterId") or metadata.get("character_id")
    return {
        "mode": "rp" if mode == "rp" else "sms",
        "sessionId": str(metadata.get("sessionId") or metadata.get("session_id") or "events"),
        "characterId": str(character_id) if character_id else None,
    }


def _proactive_memory_policy(origin: dict[str, str | None]) -> dict[str, Any]:
    return {
        "source": "proactive_event",
        "realWorld": True,
        "useAsPlotFact": False,
        "rpMemoryIsOutOfCharacter": origin["mode"] == "rp",
    }


def _rp_voice_phrase(persona: str, scenario: str) -> str:
    hint = _first_sentence(persona) or _first_sentence(scenario)
    if not hint:
        return ""
    if len(hint) > 24:
        hint = hint[:24]
    return f"保持着{hint}的分寸，"


def _compact_episode_text(text: str, limit: int = 120) -> str:
    compact = " ".join(text.replace("\n", " ").split()).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def _should_record_shared_episode(text: str) -> bool:
    normalized = re.sub(r"[\s。！？!?.,，…~～]+", "", text).lower()
    if not normalized:
        return False
    if text.lstrip().startswith("/real"):
        return False
    low_information = {
        "继续",
        "我们继续",
        "你继续",
        "然后呢",
        "嗯",
        "哦",
        "好",
        "好的",
        "收到",
        "ok",
        "okay",
        "继续说",
    }
    if normalized in low_information:
        return False
    return len(normalized) >= 3


def _first_sentence(text: str) -> str:
    stripped = " ".join(text.replace("\n", " ").split()).strip()
    if not stripped:
        return ""
    for separator in ("。", ".", "；", ";", "，", ","):
        if separator in stripped:
            stripped = stripped.split(separator, 1)[0]
            break
    return stripped.strip(" ：:，,。.;；")


def _run_assertions(response: MessageResponse, assertions: dict[str, Any], latency_ms: float) -> dict[str, bool]:
    results: dict[str, bool] = {}
    if "replyContains" in assertions:
        results["replyContains"] = str(assertions["replyContains"]) in response.reply
    if "replyNotContains" in assertions:
        results["replyNotContains"] = str(assertions["replyNotContains"]) not in response.reply
    if "actionType" in assertions:
        results["actionType"] = any(
            action.action_type == assertions["actionType"] for action in response.actions
        )
    if "actionStatus" in assertions:
        results["actionStatus"] = any(
            action.status == assertions["actionStatus"] for action in response.actions
        )
    if "contextTracePresent" in assertions:
        results["contextTracePresent"] = bool(response.context_trace_id) is bool(
            assertions["contextTracePresent"]
        )
    if "maxLatencyMs" in assertions:
        results["maxLatencyMs"] = latency_ms <= float(assertions["maxLatencyMs"])
    if "minReplyChars" in assertions:
        results["minReplyChars"] = len(response.reply) >= int(assertions["minReplyChars"])
    if "maxTokenEstimate" in assertions:
        results["maxTokenEstimate"] = bool(response.metrics) and (
            response.metrics.token_estimate <= int(assertions["maxTokenEstimate"])
        )
    if "maxContextUsageRatio" in assertions:
        results["maxContextUsageRatio"] = bool(response.metrics) and (
            response.metrics.context_usage_ratio <= float(assertions["maxContextUsageRatio"])
        )
    if "maxGeneratedTokens" in assertions:
        generated_tokens = response.metrics.generated_tokens if response.metrics else None
        results["maxGeneratedTokens"] = generated_tokens is not None and (
            generated_tokens <= int(assertions["maxGeneratedTokens"])
        )
    return results


def _elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def _safe_ratio(value: int | float, budget: int | float) -> float:
    if budget <= 0:
        return 0
    return round(float(value) / float(budget), 6)


def _rate(tokens: int | float, elapsed_ms: int | float) -> float | None:
    if elapsed_ms <= 0:
        return None
    return round(float(tokens) / (float(elapsed_ms) / 1000), 2)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def _apply_usage_to_stream_stats(usage: dict[str, Any], stream_stats: dict[str, Any]) -> None:
    if not usage:
        return
    prompt_tokens = usage.get("prompt_tokens") or usage.get("input_tokens")
    completion_tokens = usage.get("completion_tokens") or usage.get("output_tokens")
    prompt_rate = (
        usage.get("prompt_tokens_per_second")
        or usage.get("prompt_eval_rate")
        or usage.get("prefill_tokens_per_second")
    )
    generation_rate = (
        usage.get("generation_tokens_per_second")
        or usage.get("eval_rate")
        or usage.get("tokens_per_second")
    )
    if prompt_tokens is not None:
        stream_stats["prefill_tokens"] = int(prompt_tokens)
    if completion_tokens is not None:
        stream_stats["generated_tokens"] = int(completion_tokens)
    if prompt_rate is not None:
        stream_stats["prefill_tokens_per_second"] = round(float(prompt_rate), 2)
    if generation_rate is not None:
        stream_stats["generation_tokens_per_second"] = round(float(generation_rate), 2)
