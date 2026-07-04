from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .character_cards import CharacterCardError, parse_character_card
from .external_model import ExternalModelError
from .ics import export_ics, import_ics
from .kernel import Kernel
from .models import (
    CalendarEventCreate,
    CalendarEventPatch,
    CharacterCreate,
    CharacterCardImportRequest,
    CharacterPatch,
    ConfirmationDecision,
    EventDeliveryPatch,
    EvalRunRequest,
    FeatureName,
    FeaturePatch,
    MessageRequest,
    OpenAICompatibleConfigPatch,
    ReminderCreate,
    ReminderPatch,
    TaskCreate,
    TaskPatch,
)


def create_app(db_path: str | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        app.state.kernel.close()

    app = FastAPI(title="RP Agent Kernel", version="0.1.0", lifespan=lifespan)
    app.state.kernel = Kernel(db_path or os.getenv("RP_AGENT_DB", "rp_agent_kernel.sqlite3"))
    static_dir = Path(__file__).resolve().parent / "static"

    @app.middleware("http")
    async def ui_prefix_api_compat(request, call_next):
        path = request.scope.get("path", "")
        if path == "/ui/api" or path.startswith("/ui/api/"):
            request.scope["path"] = path.removeprefix("/ui")
        elif path == "/ui/health":
            request.scope["path"] = "/health"
        return await call_next(request)

    app.mount(
        "/ui/assets",
        StaticFiles(directory=str(static_dir / "assets")),
        name="ui-assets",
    )
    app.mount(
        "/ui/ui/assets",
        StaticFiles(directory=str(static_dir / "assets")),
        name="ui-assets-compat",
    )

    @app.get("/")
    def root() -> dict[str, object]:
        return {
            "name": "RP Agent Kernel",
            "status": "ok",
            "docs": "/docs",
            "ui": "/ui",
            "health": "/health",
            "capabilities": "/api/eval/capabilities",
            "messageEndpoint": "POST /api/sessions/{id}/messages",
            "sessions": "GET /api/sessions",
            "messageHistory": "GET /api/sessions/{id}/messages",
            "featureFlags": "/api/features",
            "modelConfig": "/api/model-config/openai-compatible",
            "modelList": "/api/model-config/openai-compatible/models",
            "modelLogs": "/api/model-call-logs",
            "characterImport": "POST /api/characters/import-card",
            "eventPoll": "/api/events/poll",
            "eventPending": "/api/events/pending",
        }

    @app.get("/ui", include_in_schema=False)
    @app.get("/ui/", include_in_schema=False)
    def ui() -> FileResponse:
        response = FileResponse(static_dir / "index.html")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/features")
    def get_features():
        return _kernel(app).storage.feature_records()

    @app.patch("/api/features")
    def patch_features(patch: FeaturePatch):
        return _kernel(app).storage.set_features(patch.flags)

    @app.get("/api/model-config/openai-compatible")
    def get_openai_compatible_config():
        return _kernel(app).storage.get_openai_config()

    @app.patch("/api/model-config/openai-compatible")
    def patch_openai_compatible_config(patch: OpenAICompatibleConfigPatch):
        return _kernel(app).storage.patch_openai_config(patch)

    @app.get("/api/model-config/openai-compatible/models")
    def list_openai_compatible_models():
        kernel = _kernel(app)
        _require(kernel, FeatureName.external_model)
        try:
            models = kernel.external_model.list_models(
                config=kernel.storage.get_raw_openai_config()
            )
            return {"models": models, "count": len(models)}
        except ExternalModelError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/model-call-logs")
    def list_model_call_logs(
        limit: Annotated[int, Query(ge=1, le=200)] = 30,
        session_id: Annotated[str | None, Query(alias="sessionId")] = None,
    ):
        return _kernel(app).storage.list_model_call_logs(limit=limit, session_id=session_id)

    @app.get("/api/model-call-logs/{log_id}")
    def get_model_call_log(log_id: str):
        try:
            return _kernel(app).storage.get_model_call_log(log_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="model call log not found") from exc

    @app.delete("/api/model-call-logs")
    def clear_model_call_logs():
        deleted = _kernel(app).storage.clear_model_call_logs()
        return {"deleted": deleted}

    @app.get("/api/sessions")
    def list_sessions(
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        search: Annotated[str | None, Query()] = None,
        mode: Annotated[str | None, Query()] = None,
        character_id: Annotated[str | None, Query(alias="characterId")] = None,
    ):
        return _kernel(app).storage.list_sessions(
            limit=limit,
            search=search,
            mode=mode,
            character_id=character_id,
        )

    @app.post("/api/sessions/{session_id}/messages")
    def send_message(session_id: str, request: MessageRequest):
        return _kernel(app).handle_message(session_id, request)

    @app.post("/api/sessions/{session_id}/messages/stream")
    def stream_message(session_id: str, request: MessageRequest):
        kernel = _kernel(app)

        def _events():
            try:
                for event in kernel.stream_message_events(session_id, request):
                    yield "data: " + json.dumps(event, ensure_ascii=False, default=str) + "\n\n"
            except Exception as exc:
                payload = {"type": "error", "detail": str(exc)}
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

        return StreamingResponse(_events(), media_type="text/event-stream")

    @app.get("/api/sessions/{session_id}/messages")
    def list_session_messages(
        session_id: str,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
    ):
        return _kernel(app).storage.recent_messages(session_id, limit=limit)

    @app.delete("/api/sessions/{session_id}/messages")
    def clear_session_messages(session_id: str):
        deleted = _kernel(app).storage.delete_session_messages(session_id)
        return {"sessionId": session_id, "deleted": deleted}

    @app.post("/api/sessions/{session_id}/clone")
    def clone_session(
        session_id: str,
        payload: Annotated[dict[str, str] | None, Body()] = None,
    ):
        target_session_id = ((payload or {}).get("targetSessionId") or "").strip()
        if not target_session_id:
            raise HTTPException(status_code=400, detail="targetSessionId is required")
        cloned = _kernel(app).storage.clone_session(session_id, target_session_id)
        return {
            "sourceSessionId": session_id,
            "targetSessionId": target_session_id,
            "cloned": cloned,
        }

    @app.post("/api/confirmations/{confirmation_id}")
    def confirm_action(confirmation_id: str, decision: ConfirmationDecision):
        try:
            return _kernel(app).confirm_action(confirmation_id, decision)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="confirmation not found") from exc

    @app.get("/api/events/stream")
    def event_stream(
        now: Annotated[datetime | None, Query()] = None,
    ):
        kernel = _kernel(app)
        _require(kernel, FeatureName.event_stream)
        payloads = kernel.due_events(now or datetime.now().astimezone())

        def _events():
            for payload in payloads:
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
            if not payloads:
                yield "data: " + json.dumps({"type": "Noop"}, ensure_ascii=False) + "\n\n"

        return StreamingResponse(_events(), media_type="text/event-stream")

    @app.get("/api/events/poll")
    def poll_events(
        now: Annotated[datetime | None, Query()] = None,
        include_pending: Annotated[bool, Query(alias="includePending")] = False,
    ):
        kernel = _kernel(app)
        _require(kernel, FeatureName.event_stream)
        events = kernel.due_events(
            now or datetime.now().astimezone(), include_pending=include_pending
        )
        return {"events": events, "count": len(events)}

    @app.get("/api/events/pending")
    def pending_events():
        kernel = _kernel(app)
        _require(kernel, FeatureName.event_stream)
        events = kernel.pending_events()
        return {"events": events, "count": len(events)}

    @app.post("/api/events/{delivery_id}/delivery")
    def patch_event_delivery(delivery_id: str, patch: EventDeliveryPatch):
        kernel = _kernel(app)
        _require(kernel, FeatureName.event_stream)
        try:
            return kernel.update_event_delivery(delivery_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="event delivery not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/calendar/events")
    def list_calendar_events(
        start: Annotated[datetime | None, Query()] = None,
        end: Annotated[datetime | None, Query()] = None,
    ):
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        return kernel.storage.list_events(start, end)

    @app.post("/api/calendar/events")
    def create_calendar_event(event: CalendarEventCreate):
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        return kernel.storage.create_event(event)

    @app.patch("/api/calendar/events/{event_id}")
    def patch_calendar_event(event_id: str, patch: CalendarEventPatch):
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        try:
            return kernel.storage.patch_event(event_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="event not found") from exc

    @app.delete("/api/calendar/events/{event_id}")
    def delete_calendar_event(event_id: str):
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        kernel.storage.delete_event(event_id)
        return {"deleted": event_id}

    @app.get("/api/calendar/ics", response_class=PlainTextResponse)
    def export_calendar_ics():
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        _require(kernel, FeatureName.ics)
        return export_ics(kernel.storage.list_events())

    @app.post("/api/calendar/ics")
    def import_calendar_ics(
        body: Annotated[str, Body(media_type="text/calendar")],
        timezone: str = "Asia/Shanghai",
    ):
        kernel = _kernel(app)
        _require(kernel, FeatureName.calendar)
        _require(kernel, FeatureName.ics)
        created = [kernel.storage.create_event(event) for event in import_ics(body, timezone)]
        return {"created": created, "count": len(created)}

    @app.get("/api/tasks")
    def list_tasks():
        kernel = _kernel(app)
        _require(kernel, FeatureName.tasks)
        return kernel.storage.list_tasks()

    @app.post("/api/tasks")
    def create_task(task: TaskCreate):
        kernel = _kernel(app)
        _require(kernel, FeatureName.tasks)
        return kernel.storage.create_task(task)

    @app.patch("/api/tasks/{task_id}")
    def patch_task(task_id: str, patch: TaskPatch):
        kernel = _kernel(app)
        _require(kernel, FeatureName.tasks)
        try:
            return kernel.storage.patch_task(task_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.delete("/api/tasks/{task_id}")
    def delete_task(task_id: str):
        kernel = _kernel(app)
        _require(kernel, FeatureName.tasks)
        kernel.storage.delete_task(task_id)
        return {"deleted": task_id}

    @app.get("/api/reminders")
    def list_reminders():
        kernel = _kernel(app)
        _require(kernel, FeatureName.reminders)
        return kernel.storage.list_reminders()

    @app.post("/api/reminders")
    def create_reminder(reminder: ReminderCreate):
        kernel = _kernel(app)
        _require(kernel, FeatureName.reminders)
        return kernel.storage.create_reminder(reminder)

    @app.patch("/api/reminders/{reminder_id}")
    def patch_reminder(reminder_id: str, patch: ReminderPatch):
        kernel = _kernel(app)
        _require(kernel, FeatureName.reminders)
        try:
            return kernel.storage.patch_reminder(reminder_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="reminder not found") from exc

    @app.delete("/api/reminders/{reminder_id}")
    def delete_reminder(reminder_id: str):
        kernel = _kernel(app)
        _require(kernel, FeatureName.reminders)
        kernel.storage.delete_reminder(reminder_id)
        return {"deleted": reminder_id}

    @app.get("/api/characters")
    def list_characters():
        kernel = _kernel(app)
        _require(kernel, FeatureName.characters)
        return kernel.storage.list_characters()

    @app.post("/api/characters")
    def create_character(character: CharacterCreate):
        kernel = _kernel(app)
        _require(kernel, FeatureName.characters)
        return kernel.storage.create_character(character)

    @app.post("/api/characters/import-card")
    def import_character_card(request: CharacterCardImportRequest):
        kernel = _kernel(app)
        _require(kernel, FeatureName.characters)
        try:
            character_create, parsed_format, warnings = parse_character_card(
                file_name=request.file_name,
                content=request.content,
                content_base64=request.content_base64,
            )
            character = kernel.storage.create_character(character_create)
            return {
                "parsedFormat": parsed_format,
                "character": character,
                "warnings": warnings,
            }
        except CharacterCardError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/api/characters/{character_id}")
    def patch_character(character_id: str, patch: CharacterPatch):
        kernel = _kernel(app)
        _require(kernel, FeatureName.characters)
        try:
            return kernel.storage.patch_character(character_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="character not found") from exc

    @app.delete("/api/characters/{character_id}")
    def delete_character(character_id: str):
        kernel = _kernel(app)
        _require(kernel, FeatureName.characters)
        kernel.storage.delete_character(character_id)
        return {"deleted": character_id}

    @app.get("/api/context-traces/{trace_id}")
    def get_context_trace(trace_id: str):
        kernel = _kernel(app)
        _require(kernel, FeatureName.context_trace)
        try:
            return kernel.storage.get_context_trace(trace_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="context trace not found") from exc

    @app.get("/api/eval/capabilities")
    def eval_capabilities():
        kernel = _kernel(app)
        _require(kernel, FeatureName.deterministic_eval)
        return kernel.capabilities()

    @app.post("/api/eval/run")
    def run_eval(request: EvalRunRequest):
        kernel = _kernel(app)
        _require(kernel, FeatureName.deterministic_eval)
        return kernel.run_eval(request)

    return app


def _kernel(app: FastAPI) -> Kernel:
    return app.state.kernel


def _require(kernel: Kernel, feature: FeatureName) -> None:
    if not kernel.storage.is_enabled(feature):
        raise HTTPException(status_code=403, detail=f"feature disabled: {feature.value}")
