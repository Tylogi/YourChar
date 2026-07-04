from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


Mode = Literal["sms", "rp"]


class FeatureName(str, Enum):
    calendar = "calendar"
    tasks = "tasks"
    reminders = "reminders"
    characters = "characters"
    external_model = "external_model"
    rp_memory = "rp_memory"
    secretary_memory = "secretary_memory"
    context_trace = "context_trace"
    confirmation_safety = "confirmation_safety"
    ics = "ics"
    event_stream = "event_stream"
    metrics = "metrics"
    deterministic_eval = "deterministic_eval"
    fts_search = "fts_search"


FEATURE_DESCRIPTIONS: dict[FeatureName, str] = {
    FeatureName.calendar: "Local calendar CRUD and schedule context.",
    FeatureName.tasks: "Task CRUD and task intent handling.",
    FeatureName.reminders: "Reminder CRUD, due checks, and reminder events.",
    FeatureName.characters: "RP character cards and persona context.",
    FeatureName.external_model: "OpenAI-compatible external model rendering.",
    FeatureName.rp_memory: "Isolated roleplay memory storage and retrieval.",
    FeatureName.secretary_memory: "Real-world secretary preference memory.",
    FeatureName.context_trace: "Persisted context assembly traces.",
    FeatureName.confirmation_safety: "Confirmation gates for risky actions.",
    FeatureName.ics: "ICS import and export for local calendar events.",
    FeatureName.event_stream: "SSE event stream for reminders and state changes.",
    FeatureName.metrics: "Per-request timing and context metrics.",
    FeatureName.deterministic_eval: "Agent-friendly deterministic evaluation endpoints.",
    FeatureName.fts_search: "SQLite FTS-assisted memory search.",
}


DEFAULT_FEATURE_FLAGS: dict[FeatureName, bool] = {
    FeatureName.calendar: True,
    FeatureName.tasks: True,
    FeatureName.reminders: True,
    FeatureName.characters: True,
    FeatureName.external_model: True,
    FeatureName.rp_memory: True,
    FeatureName.secretary_memory: True,
    FeatureName.context_trace: True,
    FeatureName.confirmation_safety: True,
    FeatureName.ics: True,
    FeatureName.event_stream: True,
    FeatureName.metrics: True,
    FeatureName.deterministic_eval: True,
    FeatureName.fts_search: True,
}


class KernelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, use_enum_values=True)


class FeatureFlag(KernelModel):
    name: FeatureName
    enabled: bool
    description: str


class FeaturePatch(KernelModel):
    flags: dict[FeatureName, bool]


class CalendarEvent(KernelModel):
    id: str
    title: str
    start: datetime
    end: datetime | None = None
    timezone: str = "Asia/Shanghai"
    location: str | None = None
    recurrence: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class CalendarEventCreate(KernelModel):
    title: str
    start: datetime
    end: datetime | None = None
    timezone: str = "Asia/Shanghai"
    location: str | None = None
    recurrence: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CalendarEventPatch(KernelModel):
    title: str | None = None
    start: datetime | None = None
    end: datetime | None = None
    timezone: str | None = None
    location: str | None = None
    recurrence: str | None = None
    metadata: dict[str, Any] | None = None


class Task(KernelModel):
    id: str
    title: str
    due_at: datetime | None = Field(default=None, alias="dueAt")
    timezone: str = "Asia/Shanghai"
    status: str = "open"
    priority: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class TaskCreate(KernelModel):
    title: str
    due_at: datetime | None = Field(default=None, alias="dueAt")
    timezone: str = "Asia/Shanghai"
    status: str = "open"
    priority: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


class TaskPatch(KernelModel):
    title: str | None = None
    due_at: datetime | None = Field(default=None, alias="dueAt")
    timezone: str | None = None
    status: str | None = None
    priority: int | None = None
    metadata: dict[str, Any] | None = None


class Reminder(KernelModel):
    id: str
    title: str
    remind_at: datetime = Field(alias="remindAt")
    timezone: str = "Asia/Shanghai"
    status: str = "scheduled"
    event_id: str | None = Field(default=None, alias="eventId")
    task_id: str | None = Field(default=None, alias="taskId")
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ReminderCreate(KernelModel):
    title: str
    remind_at: datetime = Field(alias="remindAt")
    timezone: str = "Asia/Shanghai"
    status: str = "scheduled"
    event_id: str | None = Field(default=None, alias="eventId")
    task_id: str | None = Field(default=None, alias="taskId")
    metadata: dict[str, Any] = Field(default_factory=dict)


class ReminderPatch(KernelModel):
    title: str | None = None
    remind_at: datetime | None = Field(default=None, alias="remindAt")
    timezone: str | None = None
    status: str | None = None
    event_id: str | None = Field(default=None, alias="eventId")
    task_id: str | None = Field(default=None, alias="taskId")
    metadata: dict[str, Any] | None = None


class Character(KernelModel):
    id: str
    name: str
    persona: str = ""
    scenario: str = ""
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class CharacterCreate(KernelModel):
    id: str | None = None
    name: str
    persona: str = ""
    scenario: str = ""
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class CharacterPatch(KernelModel):
    name: str | None = None
    persona: str | None = None
    scenario: str | None = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None


class CharacterCardImportRequest(KernelModel):
    file_name: str = Field(alias="fileName")
    content: str | None = None
    content_base64: str | None = Field(default=None, alias="contentBase64")


class CharacterCardImportResponse(KernelModel):
    parsed_format: str = Field(alias="parsedFormat")
    character: Character
    warnings: list[str] = Field(default_factory=list)


class OpenAICompatibleConfig(KernelModel):
    provider: str = "openai_compatible"
    enabled: bool = False
    base_url: str = Field(default="https://api.openai.com/v1", alias="baseUrl")
    model: str = ""
    api_key_set: bool = Field(default=False, alias="apiKeySet")
    api_key_masked: str = Field(default="", alias="apiKeyMasked")
    headers: dict[str, str] = Field(default_factory=dict)
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="maxTokens")
    context_window_tokens: int = Field(default=128000, alias="contextWindowTokens", ge=1)
    updated_at: datetime | None = None


class OpenAICompatibleConfigPatch(KernelModel):
    enabled: bool | None = None
    base_url: str | None = Field(default=None, alias="baseUrl")
    model: str | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    clear_api_key: bool = Field(default=False, alias="clearApiKey")
    headers: dict[str, str] | None = None
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="maxTokens")
    context_window_tokens: int | None = Field(default=None, alias="contextWindowTokens", ge=1)


class ModelCallLog(KernelModel):
    id: str
    provider: str = "openai_compatible"
    session_id: str = Field(alias="sessionId")
    mode: Mode
    character_id: str | None = Field(default=None, alias="characterId")
    model: str
    endpoint: str
    request: dict[str, Any]
    response: dict[str, Any] = Field(default_factory=dict)
    status: str
    error: str | None = None
    prompt_token_estimate: int = Field(default=0, alias="promptTokenEstimate")
    completion_text: str = Field(default="", alias="completionText")
    created_at: datetime
    completed_at: datetime | None = Field(default=None, alias="completedAt")


class Memory(KernelModel):
    id: str
    mode: Mode
    session_id: str = Field(alias="sessionId")
    character_id: str | None = Field(default=None, alias="characterId")
    content: str
    tags: list[str] = Field(default_factory=list)
    source: str = "message"
    created_at: datetime


class ActionRecord(KernelModel):
    id: str
    action_type: str = Field(alias="actionType")
    status: str
    feature: FeatureName | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class EventDelivery(KernelModel):
    id: str
    event_type: str = Field(alias="eventType")
    resource_id: str = Field(alias="resourceId")
    status: Literal["pending", "acked", "failed"] = "pending"
    attempts: int = 1
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    acknowledged_at: datetime | None = Field(default=None, alias="acknowledgedAt")
    last_error: str | None = Field(default=None, alias="lastError")


class EventDeliveryPatch(KernelModel):
    status: Literal["pending", "acked", "failed"]
    error: str | None = None


class ConfirmationRecord(KernelModel):
    id: str
    action_type: str = Field(alias="actionType")
    status: str = "pending"
    reason: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    decided_at: datetime | None = Field(default=None, alias="decidedAt")


class ConfirmationDecision(KernelModel):
    decision: Literal["approved", "rejected"]


class ContextTraceBlock(KernelModel):
    id: str
    layer: Literal["stable", "semi_stable", "dynamic"]
    name: str
    hash: str
    token_count: int = Field(alias="tokenCount")
    source: str
    truncated: bool = False


class ContextTrace(KernelModel):
    id: str
    session_id: str = Field(alias="sessionId")
    mode: Mode
    character_id: str | None = Field(default=None, alias="characterId")
    blocks: list[ContextTraceBlock]
    feature_flags: dict[str, bool] = Field(alias="featureFlags")
    created_at: datetime


class MessageMetrics(KernelModel):
    latency_ms: float = Field(alias="latencyMs")
    planner_ms: float = Field(alias="plannerMs")
    context_ms: float = Field(alias="contextMs")
    tool_ms: float = Field(alias="toolMs")
    renderer_ms: float = Field(alias="rendererMs")
    token_estimate: int = Field(alias="tokenEstimate")
    context_window_tokens: int = Field(default=128000, alias="contextWindowTokens")
    context_usage_ratio: float = Field(default=0, alias="contextUsageRatio")
    prefill_ms: float | None = Field(default=None, alias="prefillMs")
    prefill_tokens: int | None = Field(default=None, alias="prefillTokens")
    prefill_tokens_per_second: float | None = Field(default=None, alias="prefillTokensPerSecond")
    generated_tokens: int | None = Field(default=None, alias="generatedTokens")
    generation_tokens_per_second: float | None = Field(default=None, alias="generationTokensPerSecond")
    action_count: int = Field(alias="actionCount")
    feature_flags: dict[str, bool] = Field(alias="featureFlags")


class MessageRequest(KernelModel):
    mode: Mode = "sms"
    text: str
    now: datetime | None = None
    timezone: str = "Asia/Shanghai"
    character_id: str | None = Field(default=None, alias="characterId")
    eval_options: dict[str, Any] = Field(default_factory=dict, alias="evalOptions")


class MessageResponse(KernelModel):
    reply: str
    actions: list[ActionRecord] = Field(default_factory=list)
    confirmations: list[ConfirmationRecord] = Field(default_factory=list)
    context_trace_id: str | None = Field(default=None, alias="contextTraceId")
    metrics: MessageMetrics | None = None


class EvalCase(KernelModel):
    id: str
    session_id: str = Field(alias="sessionId")
    request: MessageRequest
    assertions: dict[str, Any] = Field(default_factory=dict)


class EvalSeed(KernelModel):
    calendar_events: list[CalendarEventCreate] = Field(default_factory=list, alias="calendarEvents")
    tasks: list[TaskCreate] = Field(default_factory=list)
    reminders: list[ReminderCreate] = Field(default_factory=list)
    characters: list[CharacterCreate] = Field(default_factory=list)
    feature_flags: dict[FeatureName, bool] = Field(default_factory=dict, alias="featureFlags")


class EvalRunRequest(KernelModel):
    cases: list[EvalCase]
    seed: EvalSeed = Field(default_factory=EvalSeed)
    repeat: int = 1
    isolate: bool = True


class EvalCaseResult(KernelModel):
    id: str
    repeat_index: int = Field(alias="repeatIndex")
    response: MessageResponse
    passed: bool
    assertion_results: dict[str, bool] = Field(alias="assertionResults")
    latency_ms: float = Field(alias="latencyMs")


class EvalRunResponse(KernelModel):
    deterministic: bool
    feature_flags: dict[str, bool] = Field(alias="featureFlags")
    results: list[EvalCaseResult]
    summary: dict[str, Any]


class CapabilityReport(KernelModel):
    modes: list[Mode]
    features: list[FeatureFlag]
    endpoints: list[str]
    sdk_methods: list[str] = Field(alias="sdkMethods")
    eval_contract_version: str = Field(alias="evalContractVersion")
