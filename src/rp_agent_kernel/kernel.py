from __future__ import annotations

import statistics
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .context import ContextBuilder
from .external_model import ExternalModelError, ExternalModelStreamState, OpenAICompatibleClient
from .models import (
    CapabilityReport,
    ConfirmationDecision,
    EvalCaseResult,
    EvalRunRequest,
    EvalRunResponse,
    FeatureName,
    MessageMetrics,
    MessageRequest,
    MessageResponse,
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
        fallback_reply = self.renderer.render(request, execution)
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

        return MessageResponse(
            reply=reply,
            actions=prepared.execution.actions,
            confirmations=prepared.execution.confirmations,
            contextTraceId=prepared.context.trace_id,
            metrics=metrics,
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
                "GET/POST/PATCH/DELETE /api/calendar/events",
                "GET/POST/PATCH/DELETE /api/tasks",
                "GET/POST/PATCH/DELETE /api/reminders",
                "GET/POST/PATCH/DELETE /api/characters",
                "POST /api/characters/import-card",
                "GET/PATCH /api/model-config/openai-compatible",
                "GET /api/model-config/openai-compatible/models",
                "GET/DELETE /api/model-call-logs",
                "GET/PATCH /api/features",
                "GET /api/context-traces/{id}",
                "POST /api/confirmations/{id}",
                "GET /api/eval/capabilities",
                "POST /api/eval/run",
            ],
            sdkMethods=[
                "sendMessage(sessionId, mode, text)",
                "subscribeEvents(handler)",
                "listSchedule(range)",
                "confirmAction(actionId, decision)",
                "getFeatures()",
                "setFeature(name, enabled)",
                "getOpenAICompatibleConfig()",
                "setOpenAICompatibleConfig(config)",
                "listOpenAICompatibleModels()",
                "importCharacterCard(file)",
                "runEval(cases)",
            ],
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
            summary: dict[str, Any] = {
                "total": len(results),
                "passed": sum(1 for result in results if result.passed),
                "failed": sum(1 for result in results if not result.passed),
                "meanLatencyMs": statistics.mean(latencies) if latencies else 0,
                "maxLatencyMs": max(latencies) if latencies else 0,
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
