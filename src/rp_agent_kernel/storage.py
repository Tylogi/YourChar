from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .models import (
    DEFAULT_FEATURE_FLAGS,
    FEATURE_DESCRIPTIONS,
    ActionRecord,
    CalendarEvent,
    CalendarEventCreate,
    CalendarEventPatch,
    Character,
    CharacterCreate,
    CharacterPatch,
    ConfirmationRecord,
    ContextTrace,
    ContextTraceBlock,
    EventDelivery,
    EventDeliveryPatch,
    FeatureFlag,
    FeatureName,
    Memory,
    ModelCallLog,
    OpenAICompatibleConfig,
    OpenAICompatibleConfigPatch,
    Reminder,
    ReminderCreate,
    ReminderPatch,
    Task,
    TaskCreate,
    TaskPatch,
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    return json.loads(value)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _claim_owner_required(delivery: EventDelivery) -> bool:
    return delivery.status == "claimed" and bool(delivery.claimed_by)


class Storage:
    def __init__(self, path: str | Path = "rp_agent_kernel.sqlite3") -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._fts_available = False
        self.init_schema()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def init_schema(self) -> None:
        with self._lock, self.conn:
            self.conn.executescript(
                """
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS features (
                    name TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL,
                    description TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    character_id TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS calendar_events (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    start TEXT NOT NULL,
                    end TEXT,
                    timezone TEXT NOT NULL,
                    location TEXT,
                    recurrence TEXT,
                    metadata TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    due_at TEXT,
                    timezone TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority INTEGER NOT NULL,
                    metadata TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS reminders (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    remind_at TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    status TEXT NOT NULL,
                    event_id TEXT,
                    task_id TEXT,
                    metadata TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS characters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    persona TEXT NOT NULL,
                    scenario TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    metadata TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    character_id TEXT,
                    content TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS confirmations (
                    id TEXT PRIMARY KEY,
                    action_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    decided_at TEXT
                );

                CREATE TABLE IF NOT EXISTS actions (
                    id TEXT PRIMARY KEY,
                    action_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    feature TEXT,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS event_deliveries (
                    id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    acknowledged_at TEXT,
                    last_error TEXT,
                    claimed_by TEXT,
                    claim_expires_at TEXT
                );

                CREATE UNIQUE INDEX IF NOT EXISTS event_deliveries_source_idx
                ON event_deliveries (event_type, resource_id);

                CREATE TABLE IF NOT EXISTS context_traces (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    character_id TEXT,
                    blocks TEXT NOT NULL,
                    feature_flags TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS model_configs (
                    provider TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL,
                    base_url TEXT NOT NULL,
                    api_key TEXT NOT NULL,
                    model TEXT NOT NULL,
                    headers TEXT NOT NULL,
                    temperature REAL,
                    max_tokens INTEGER,
                    context_window_tokens INTEGER NOT NULL DEFAULT 128000,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS model_call_logs (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    character_id TEXT,
                    model TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error TEXT,
                    prompt_token_estimate INTEGER NOT NULL,
                    completion_text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
                """
            )
            self._ensure_column(
                "model_configs",
                "context_window_tokens",
                "INTEGER NOT NULL DEFAULT 128000",
            )
            self._ensure_column("event_deliveries", "claimed_by", "TEXT")
            self._ensure_column("event_deliveries", "claim_expires_at", "TEXT")
            try:
                self.conn.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
                    USING fts5(memory_id UNINDEXED, content, tags)
                    """
                )
                self._fts_available = True
            except sqlite3.Error:
                self._fts_available = False
            for name, enabled in DEFAULT_FEATURE_FLAGS.items():
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO features (name, enabled, description)
                    VALUES (?, ?, ?)
                    """,
                    (name.value, int(enabled), FEATURE_DESCRIPTIONS[name]),
                )

    def _ensure_column(self, table: str, column: str, definition: str) -> None:
        existing = {
            row["name"]
            for row in self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in existing:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def add_message(
        self,
        *,
        session_id: str,
        mode: str,
        role: str,
        content: str,
        character_id: str | None = None,
    ) -> None:
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO messages (id, session_id, mode, role, content, character_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    session_id,
                    mode,
                    role,
                    content,
                    character_id,
                    _iso(utc_now()),
                ),
            )

    def recent_messages(self, session_id: str, limit: int = 8) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT id, role, content, mode, character_id, created_at
                FROM messages
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def list_sessions(
        self,
        *,
        limit: int = 100,
        search: str | None = None,
        mode: str | None = None,
        character_id: str | None = None,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT id, session_id, role, content, mode, character_id, created_at
                FROM messages
                ORDER BY created_at DESC
                """
            ).fetchall()

        query = (search or "").strip().lower()
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["session_id"]] = counts.get(row["session_id"], 0) + 1
        for row in rows:
            session_id = row["session_id"]
            if session_id in seen:
                continue
            seen.add(session_id)
            summary = {
                "id": session_id,
                "sessionId": session_id,
                "mode": row["mode"],
                "characterId": row["character_id"],
                "messageCount": counts.get(session_id, 0),
                "lastRole": row["role"],
                "lastPreview": row["content"][:160],
                "updatedAt": row["created_at"],
            }
            if mode and mode != "all" and summary["mode"] != mode:
                continue
            if character_id and summary["characterId"] != character_id:
                continue
            if query:
                haystack = " ".join(
                    str(summary.get(key) or "")
                    for key in ("sessionId", "mode", "characterId", "lastPreview")
                ).lower()
                if query not in haystack:
                    continue
            result.append(summary)
            if len(result) >= limit:
                break
        return result

    def delete_session_messages(self, session_id: str) -> int:
        with self._lock, self.conn:
            count = self.conn.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()[0]
            self.conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        return int(count)

    def clone_session(self, source_session_id: str, target_session_id: str) -> int:
        messages = self.recent_messages(source_session_id, limit=200)
        if not messages:
            return 0
        now = utc_now()
        with self._lock, self.conn:
            for index, message in enumerate(messages):
                created_at = now.replace(microsecond=min(999999, now.microsecond + index))
                self.conn.execute(
                    """
                    INSERT INTO messages
                    (id, session_id, mode, role, content, character_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        target_session_id,
                        message["mode"],
                        message["role"],
                        message["content"],
                        message.get("character_id"),
                        _iso(created_at),
                    ),
                )
        return len(messages)

    def get_openai_config(self) -> OpenAICompatibleConfig:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM model_configs WHERE provider = 'openai_compatible'"
            ).fetchone()
        if row is None:
            return OpenAICompatibleConfig()
        return self._row_to_openai_config(row)

    def patch_openai_config(self, patch: OpenAICompatibleConfigPatch) -> OpenAICompatibleConfig:
        current = self.get_raw_openai_config()
        values = {
            "provider": "openai_compatible",
            "enabled": current["enabled"],
            "base_url": current["base_url"],
            "api_key": current["api_key"],
            "model": current["model"],
            "headers": current["headers"],
            "temperature": current["temperature"],
            "max_tokens": current["max_tokens"],
            "context_window_tokens": current["context_window_tokens"],
        }
        updates = patch.model_dump(exclude_unset=True)
        if "enabled" in updates:
            values["enabled"] = bool(updates["enabled"])
        if updates.get("base_url") is not None:
            values["base_url"] = str(updates["base_url"]).strip()
        if updates.get("model") is not None:
            values["model"] = str(updates["model"]).strip()
        if updates.get("headers") is not None:
            values["headers"] = updates["headers"] or {}
        if "temperature" in updates:
            values["temperature"] = updates["temperature"]
        if "max_tokens" in updates:
            values["max_tokens"] = updates["max_tokens"]
        if updates.get("context_window_tokens") is not None:
            values["context_window_tokens"] = int(updates["context_window_tokens"])
        if updates.get("clear_api_key"):
            values["api_key"] = ""
        elif updates.get("api_key") is not None:
            values["api_key"] = str(updates["api_key"]).strip()

        updated_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO model_configs
                (
                    provider, enabled, base_url, api_key, model, headers, temperature,
                    max_tokens, context_window_tokens, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                    enabled = excluded.enabled,
                    base_url = excluded.base_url,
                    api_key = excluded.api_key,
                    model = excluded.model,
                    headers = excluded.headers,
                    temperature = excluded.temperature,
                    max_tokens = excluded.max_tokens,
                    context_window_tokens = excluded.context_window_tokens,
                    updated_at = excluded.updated_at
                """,
                (
                    values["provider"],
                    int(values["enabled"]),
                    values["base_url"],
                    values["api_key"],
                    values["model"],
                    _json(values["headers"]),
                    values["temperature"],
                    values["max_tokens"],
                    values["context_window_tokens"],
                    _iso(updated_at),
                ),
            )
        return self.get_openai_config()

    def get_raw_openai_config(self) -> dict[str, Any]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM model_configs WHERE provider = 'openai_compatible'"
            ).fetchone()
        if row is None:
            return {
                "enabled": False,
                "base_url": "https://api.openai.com/v1",
                "api_key": "",
                "model": "",
                "headers": {},
                "temperature": None,
                "max_tokens": None,
                "context_window_tokens": 128000,
            }
        return {
            "enabled": bool(row["enabled"]),
            "base_url": row["base_url"],
            "api_key": row["api_key"],
            "model": row["model"],
            "headers": _loads(row["headers"], {}),
            "temperature": row["temperature"],
            "max_tokens": row["max_tokens"],
            "context_window_tokens": row["context_window_tokens"] or 128000,
        }

    def create_model_call_log(
        self,
        *,
        provider: str,
        session_id: str,
        mode: str,
        character_id: str | None,
        model: str,
        endpoint: str,
        request: dict[str, Any],
        prompt_token_estimate: int,
    ) -> ModelCallLog:
        now = utc_now()
        log_id = str(uuid.uuid4())
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO model_call_logs
                (
                    id, provider, session_id, mode, character_id, model, endpoint,
                    request_json, response_json, status, error, prompt_token_estimate,
                    completion_text, created_at, completed_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    log_id,
                    provider,
                    session_id,
                    mode,
                    character_id,
                    model,
                    endpoint,
                    _json(request),
                    _json({}),
                    "started",
                    None,
                    int(prompt_token_estimate),
                    "",
                    _iso(now),
                    None,
                ),
            )
        return self.get_model_call_log(log_id)

    def complete_model_call_log(
        self,
        log_id: str,
        *,
        status: str,
        response: dict[str, Any] | None = None,
        completion_text: str = "",
        error: str | None = None,
    ) -> ModelCallLog:
        completed_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                UPDATE model_call_logs
                SET response_json = ?, status = ?, error = ?, completion_text = ?, completed_at = ?
                WHERE id = ?
                """,
                (
                    _json(response or {}),
                    status,
                    error,
                    completion_text,
                    _iso(completed_at),
                    log_id,
                ),
            )
        return self.get_model_call_log(log_id)

    def list_model_call_logs(
        self, *, limit: int = 30, session_id: str | None = None
    ) -> list[ModelCallLog]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            if session_id:
                rows = self.conn.execute(
                    """
                    SELECT * FROM model_call_logs
                    WHERE session_id = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (session_id, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    """
                    SELECT * FROM model_call_logs
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
        return [self._row_to_model_call_log(row) for row in rows]

    def get_model_call_log(self, log_id: str) -> ModelCallLog:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM model_call_logs WHERE id = ?", (log_id,)
            ).fetchone()
        if row is None:
            raise KeyError(log_id)
        return self._row_to_model_call_log(row)

    def clear_model_call_logs(self) -> int:
        with self._lock, self.conn:
            count = self.conn.execute("SELECT COUNT(*) FROM model_call_logs").fetchone()[0]
            self.conn.execute("DELETE FROM model_call_logs")
        return int(count)

    def feature_flags(self) -> dict[FeatureName, bool]:
        with self._lock:
            rows = self.conn.execute("SELECT name, enabled FROM features").fetchall()
        return {FeatureName(row["name"]): bool(row["enabled"]) for row in rows}

    def feature_flags_json(self) -> dict[str, bool]:
        return {name.value: enabled for name, enabled in self.feature_flags().items()}

    def feature_records(self) -> list[FeatureFlag]:
        flags = self.feature_flags()
        return [
            FeatureFlag(
                name=name,
                enabled=flags.get(name, DEFAULT_FEATURE_FLAGS[name]),
                description=FEATURE_DESCRIPTIONS[name],
            )
            for name in FeatureName
        ]

    def is_enabled(self, feature: FeatureName) -> bool:
        return self.feature_flags().get(feature, DEFAULT_FEATURE_FLAGS[feature])

    def set_features(self, updates: dict[FeatureName | str, bool]) -> list[FeatureFlag]:
        with self._lock, self.conn:
            for raw_name, enabled in updates.items():
                name = raw_name if isinstance(raw_name, FeatureName) else FeatureName(raw_name)
                self.conn.execute(
                    """
                    INSERT INTO features (name, enabled, description)
                    VALUES (?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled
                    """,
                    (name.value, int(enabled), FEATURE_DESCRIPTIONS[name]),
                )
        return self.feature_records()

    def create_event(self, data: CalendarEventCreate) -> CalendarEvent:
        now = utc_now()
        event_id = str(uuid.uuid4())
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO calendar_events
                (id, title, start, end, timezone, location, recurrence, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    data.title,
                    _iso(data.start),
                    _iso(data.end),
                    data.timezone,
                    data.location,
                    data.recurrence,
                    _json(data.metadata),
                    _iso(now),
                    _iso(now),
                ),
            )
        return self.get_event(event_id)

    def get_event(self, event_id: str) -> CalendarEvent:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM calendar_events WHERE id = ?", (event_id,)
            ).fetchone()
        if row is None:
            raise KeyError(event_id)
        return self._row_to_event(row)

    def list_events(
        self, start: datetime | None = None, end: datetime | None = None
    ) -> list[CalendarEvent]:
        sql = "SELECT * FROM calendar_events"
        params: list[Any] = []
        clauses: list[str] = []
        if start is not None:
            clauses.append("start >= ?")
            params.append(_iso(start))
        if end is not None:
            clauses.append("start <= ?")
            params.append(_iso(end))
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY start ASC"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [self._row_to_event(row) for row in rows]

    def patch_event(self, event_id: str, patch: CalendarEventPatch) -> CalendarEvent:
        current = self.get_event(event_id)
        values = current.model_dump()
        update = patch.model_dump(exclude_unset=True)
        values.update(update)
        updated = CalendarEventCreate(
            title=values["title"],
            start=values["start"],
            end=values.get("end"),
            timezone=values.get("timezone") or "Asia/Shanghai",
            location=values.get("location"),
            recurrence=values.get("recurrence"),
            metadata=values.get("metadata") or {},
        )
        with self._lock, self.conn:
            self.conn.execute(
                """
                UPDATE calendar_events
                SET title = ?, start = ?, end = ?, timezone = ?, location = ?,
                    recurrence = ?, metadata = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    updated.title,
                    _iso(updated.start),
                    _iso(updated.end),
                    updated.timezone,
                    updated.location,
                    updated.recurrence,
                    _json(updated.metadata),
                    _iso(utc_now()),
                    event_id,
                ),
            )
        return self.get_event(event_id)

    def delete_event(self, event_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))

    def delete_all_events(self) -> int:
        with self._lock, self.conn:
            count = self.conn.execute("SELECT COUNT(*) FROM calendar_events").fetchone()[0]
            self.conn.execute("DELETE FROM calendar_events")
        return int(count)

    def create_task(self, data: TaskCreate) -> Task:
        now = utc_now()
        task_id = str(uuid.uuid4())
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO tasks
                (id, title, due_at, timezone, status, priority, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    data.title,
                    _iso(data.due_at),
                    data.timezone,
                    data.status,
                    data.priority,
                    _json(data.metadata),
                    _iso(now),
                    _iso(now),
                ),
            )
        return self.get_task(task_id)

    def get_task(self, task_id: str) -> Task:
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return self._row_to_task(row)

    def list_tasks(self) -> list[Task]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
        return [self._row_to_task(row) for row in rows]

    def patch_task(self, task_id: str, patch: TaskPatch) -> Task:
        current = self.get_task(task_id)
        values = current.model_dump()
        values.update(patch.model_dump(exclude_unset=True))
        with self._lock, self.conn:
            self.conn.execute(
                """
                UPDATE tasks
                SET title = ?, due_at = ?, timezone = ?, status = ?, priority = ?,
                    metadata = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    values["title"],
                    _iso(values.get("due_at")),
                    values.get("timezone") or "Asia/Shanghai",
                    values.get("status") or "open",
                    int(values.get("priority") or 0),
                    _json(values.get("metadata") or {}),
                    _iso(utc_now()),
                    task_id,
                ),
            )
        return self.get_task(task_id)

    def delete_task(self, task_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))

    def create_reminder(self, data: ReminderCreate) -> Reminder:
        now = utc_now()
        reminder_id = str(uuid.uuid4())
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO reminders
                (id, title, remind_at, timezone, status, event_id, task_id, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    reminder_id,
                    data.title,
                    _iso(data.remind_at),
                    data.timezone,
                    data.status,
                    data.event_id,
                    data.task_id,
                    _json(data.metadata),
                    _iso(now),
                    _iso(now),
                ),
            )
        return self.get_reminder(reminder_id)

    def get_reminder(self, reminder_id: str) -> Reminder:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM reminders WHERE id = ?", (reminder_id,)
            ).fetchone()
        if row is None:
            raise KeyError(reminder_id)
        return self._row_to_reminder(row)

    def list_reminders(self) -> list[Reminder]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM reminders ORDER BY remind_at ASC").fetchall()
        return [self._row_to_reminder(row) for row in rows]

    def patch_reminder(self, reminder_id: str, patch: ReminderPatch) -> Reminder:
        current = self.get_reminder(reminder_id)
        values = current.model_dump()
        values.update(patch.model_dump(exclude_unset=True))
        with self._lock, self.conn:
            self.conn.execute(
                """
                UPDATE reminders
                SET title = ?, remind_at = ?, timezone = ?, status = ?, event_id = ?,
                    task_id = ?, metadata = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    values["title"],
                    _iso(values["remind_at"]),
                    values.get("timezone") or "Asia/Shanghai",
                    values.get("status") or "scheduled",
                    values.get("event_id"),
                    values.get("task_id"),
                    _json(values.get("metadata") or {}),
                    _iso(utc_now()),
                    reminder_id,
                ),
            )
        return self.get_reminder(reminder_id)

    def delete_reminder(self, reminder_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))

    def due_reminders(self, now: datetime) -> list[Reminder]:
        with self._lock, self.conn:
            rows = self.conn.execute(
                """
                SELECT * FROM reminders
                WHERE status = 'scheduled' AND strftime('%s', remind_at) <= strftime('%s', ?)
                ORDER BY remind_at ASC
                """,
                (_iso(now),),
            ).fetchall()
            reminder_ids = [row["id"] for row in rows]
            for reminder_id in reminder_ids:
                self.conn.execute(
                    "UPDATE reminders SET status = 'due', updated_at = ? WHERE id = ?",
                    (_iso(utc_now()), reminder_id),
                )
        return [self.get_reminder(reminder_id) for reminder_id in reminder_ids]

    def due_tasks(self, now: datetime) -> list[Task]:
        with self._lock, self.conn:
            rows = self.conn.execute(
                """
                SELECT * FROM tasks
                WHERE status = 'open'
                    AND due_at IS NOT NULL
                    AND strftime('%s', due_at) <= strftime('%s', ?)
                ORDER BY due_at ASC
                """,
                (_iso(now),),
            ).fetchall()
            task_ids = [row["id"] for row in rows]
            for task_id in task_ids:
                self.conn.execute(
                    "UPDATE tasks SET status = 'overdue', updated_at = ? WHERE id = ?",
                    (_iso(utc_now()), task_id),
                )
        return [self.get_task(task_id) for task_id in task_ids]

    def create_character(self, data: CharacterCreate) -> Character:
        now = utc_now()
        character_id = data.id or str(uuid.uuid4())
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO characters
                (id, name, persona, scenario, tags, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    character_id,
                    data.name,
                    data.persona,
                    data.scenario,
                    _json(data.tags),
                    _json(data.metadata),
                    _iso(now),
                    _iso(now),
                ),
            )
        return self.get_character(character_id)

    def get_character(self, character_id: str) -> Character:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM characters WHERE id = ?", (character_id,)
            ).fetchone()
        if row is None:
            raise KeyError(character_id)
        return self._row_to_character(row)

    def list_characters(self) -> list[Character]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM characters ORDER BY name ASC").fetchall()
        return [self._row_to_character(row) for row in rows]

    def patch_character(self, character_id: str, patch: CharacterPatch) -> Character:
        current = self.get_character(character_id)
        values = current.model_dump()
        values.update(patch.model_dump(exclude_unset=True))
        with self._lock, self.conn:
            self.conn.execute(
                """
                UPDATE characters
                SET name = ?, persona = ?, scenario = ?, tags = ?, metadata = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    values["name"],
                    values.get("persona") or "",
                    values.get("scenario") or "",
                    _json(values.get("tags") or []),
                    _json(values.get("metadata") or {}),
                    _iso(utc_now()),
                    character_id,
                ),
            )
        return self.get_character(character_id)

    def delete_character(self, character_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))

    def add_memory(
        self,
        *,
        mode: str,
        session_id: str,
        character_id: str | None,
        content: str,
        tags: list[str],
        source: str = "message",
    ) -> Memory:
        memory_id = str(uuid.uuid4())
        created_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO memories
                (id, mode, session_id, character_id, content, tags, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    mode,
                    session_id,
                    character_id,
                    content,
                    _json(tags),
                    source,
                    _iso(created_at),
                ),
            )
            if self._fts_available:
                self.conn.execute(
                    """
                    INSERT INTO memories_fts (memory_id, content, tags)
                    VALUES (?, ?, ?)
                    """,
                    (memory_id, content, " ".join(tags)),
                )
        return Memory(
            id=memory_id,
            mode=mode,
            sessionId=session_id,
            characterId=character_id,
            content=content,
            tags=tags,
            source=source,
            created_at=created_at,
        )

    def recent_memories(
        self, *, mode: str, session_id: str | None = None, character_id: str | None = None, limit: int = 8
    ) -> list[Memory]:
        clauses = ["mode = ?"]
        params: list[Any] = [mode]
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(session_id)
        if character_id is not None:
            clauses.append("character_id = ?")
            params.append(character_id)
        with self._lock:
            rows = self.conn.execute(
                f"""
                SELECT * FROM memories
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at DESC
                LIMIT ?
                """,
                [*params, limit],
            ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def search_memories(
        self, *, mode: str, query: str, character_id: str | None = None, limit: int = 5
    ) -> list[Memory]:
        like = f"%{query}%"
        clauses = ["mode = ?", "content LIKE ?"]
        params: list[Any] = [mode, like]
        if character_id is not None:
            clauses.append("character_id = ?")
            params.append(character_id)
        with self._lock:
            rows = self.conn.execute(
                f"""
                SELECT * FROM memories
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at DESC
                LIMIT ?
                """,
                [*params, limit],
            ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def add_action(
        self,
        *,
        action_type: str,
        status: str,
        feature: FeatureName | None,
        payload: dict[str, Any],
    ) -> ActionRecord:
        action_id = str(uuid.uuid4())
        created_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO actions (id, action_type, status, feature, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    action_id,
                    action_type,
                    status,
                    feature.value if feature else None,
                    _json(payload),
                    _iso(created_at),
                ),
            )
        return ActionRecord(
            id=action_id,
            actionType=action_type,
            status=status,
            feature=feature,
            payload=payload,
            created_at=created_at,
        )

    def add_event_delivery(
        self,
        *,
        event_type: str,
        resource_id: str,
        payload: dict[str, Any],
    ) -> EventDelivery:
        delivery_id = str(uuid.uuid4())
        now = utc_now()
        with self._lock, self.conn:
            try:
                self.conn.execute(
                    """
                    INSERT INTO event_deliveries
                    (id, event_type, resource_id, status, attempts, payload,
                        created_at, updated_at, acknowledged_at, last_error)
                    VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        delivery_id,
                        event_type,
                        resource_id,
                        _json(payload),
                        _iso(now),
                        _iso(now),
                    ),
                )
            except sqlite3.IntegrityError:
                row = self.conn.execute(
                    """
                    SELECT * FROM event_deliveries
                    WHERE event_type = ? AND resource_id = ?
                    """,
                    (event_type, resource_id),
                ).fetchone()
                if row is not None:
                    return self._row_to_event_delivery(row)
                raise
        return self.get_event_delivery(delivery_id)

    def get_event_delivery(self, delivery_id: str) -> EventDelivery:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM event_deliveries WHERE id = ?", (delivery_id,)
            ).fetchone()
        if row is None:
            raise KeyError(delivery_id)
        return self._row_to_event_delivery(row)

    def list_event_deliveries(
        self, statuses: list[str] | tuple[str, ...] | None = None
    ) -> list[EventDelivery]:
        sql = "SELECT * FROM event_deliveries"
        params: list[Any] = []
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            sql += f" WHERE status IN ({placeholders})"
            params.extend(statuses)
        sql += " ORDER BY created_at ASC"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [self._row_to_event_delivery(row) for row in rows]

    def claim_event_deliveries(
        self,
        *,
        client_id: str,
        lease_seconds: int,
        now: datetime | None = None,
        delivery_ids: list[str] | None = None,
    ) -> list[EventDelivery]:
        claimed_at = now or utc_now()
        expires_at = claimed_at + timedelta(seconds=max(1, lease_seconds))
        clauses = [
            """
            (
                status IN ('pending', 'failed')
                OR (
                    status = 'claimed'
                    AND claim_expires_at IS NOT NULL
                    AND strftime('%s', claim_expires_at) <= strftime('%s', ?)
                )
            )
            """
        ]
        params: list[Any] = [_iso(claimed_at)]
        if delivery_ids:
            placeholders = ",".join("?" for _ in delivery_ids)
            clauses.append(f"id IN ({placeholders})")
            params.extend(delivery_ids)
        with self._lock, self.conn:
            rows = self.conn.execute(
                f"""
                SELECT * FROM event_deliveries
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at ASC
                """,
                params,
            ).fetchall()
            delivery_ids = [row["id"] for row in rows]
            for row in rows:
                should_increment = row["status"] in ("failed", "claimed")
                attempts_sql = "attempts + 1" if should_increment else "attempts"
                self.conn.execute(
                    f"""
                    UPDATE event_deliveries
                    SET status = 'claimed',
                        attempts = {attempts_sql},
                        updated_at = ?,
                        claimed_by = ?,
                        claim_expires_at = ?
                    WHERE id = ?
                    """,
                    (_iso(claimed_at), client_id, _iso(expires_at), row["id"]),
                )
        return [self.get_event_delivery(delivery_id) for delivery_id in delivery_ids]

    def patch_event_delivery(
        self, delivery_id: str, patch: EventDeliveryPatch
    ) -> EventDelivery:
        current = self.get_event_delivery(delivery_id)
        now = utc_now()
        if current.status == "acked":
            if patch.status == "acked":
                return current
            raise ValueError("acked event delivery cannot be changed")
        if _claim_owner_required(current) and patch.client_id != current.claimed_by:
            raise PermissionError("event delivery is claimed by another client")

        acknowledged_at = now if patch.status == "acked" else None
        attempts_sql = (
            "attempts + 1"
            if current.status == "failed" and patch.status == "pending"
            else "attempts"
        )
        last_error = patch.error if patch.status == "failed" else current.last_error
        if patch.status == "acked":
            last_error = None
        claimed_by = (
            None if patch.status in ("pending", "acked", "failed") else current.claimed_by
        )
        claim_expires_at = (
            None
            if patch.status in ("pending", "acked", "failed")
            else current.claim_expires_at
        )
        with self._lock, self.conn:
            cursor = self.conn.execute(
                f"""
                UPDATE event_deliveries
                SET status = ?, attempts = {attempts_sql}, updated_at = ?,
                    acknowledged_at = ?, last_error = ?, claimed_by = ?,
                    claim_expires_at = ?
                WHERE id = ?
                """,
                (
                    patch.status,
                    _iso(now),
                    _iso(acknowledged_at),
                    last_error,
                    claimed_by,
                    _iso(claim_expires_at),
                    delivery_id,
                ),
            )
            if cursor.rowcount == 0:
                raise KeyError(delivery_id)
        return self.get_event_delivery(delivery_id)

    def add_confirmation(
        self, *, action_type: str, reason: str, payload: dict[str, Any]
    ) -> ConfirmationRecord:
        confirmation_id = str(uuid.uuid4())
        created_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO confirmations (id, action_type, status, reason, payload, created_at, decided_at)
                VALUES (?, ?, 'pending', ?, ?, ?, NULL)
                """,
                (confirmation_id, action_type, reason, _json(payload), _iso(created_at)),
            )
        return ConfirmationRecord(
            id=confirmation_id,
            actionType=action_type,
            status="pending",
            reason=reason,
            payload=payload,
            created_at=created_at,
        )

    def get_confirmation(self, confirmation_id: str) -> ConfirmationRecord:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM confirmations WHERE id = ?", (confirmation_id,)
            ).fetchone()
        if row is None:
            raise KeyError(confirmation_id)
        return self._row_to_confirmation(row)

    def decide_confirmation(self, confirmation_id: str, decision: str) -> ConfirmationRecord:
        status = "approved" if decision == "approved" else "rejected"
        with self._lock, self.conn:
            self.conn.execute(
                "UPDATE confirmations SET status = ?, decided_at = ? WHERE id = ?",
                (status, _iso(utc_now()), confirmation_id),
            )
        return self.get_confirmation(confirmation_id)

    def create_context_trace(
        self,
        *,
        session_id: str,
        mode: str,
        character_id: str | None,
        blocks: list[ContextTraceBlock],
        feature_flags: dict[str, bool],
    ) -> ContextTrace:
        trace_id = str(uuid.uuid4())
        created_at = utc_now()
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO context_traces
                (id, session_id, mode, character_id, blocks, feature_flags, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    session_id,
                    mode,
                    character_id,
                    _json([block.model_dump(mode="json", by_alias=True) for block in blocks]),
                    _json(feature_flags),
                    _iso(created_at),
                ),
            )
        return ContextTrace(
            id=trace_id,
            sessionId=session_id,
            mode=mode,
            characterId=character_id,
            blocks=blocks,
            featureFlags=feature_flags,
            created_at=created_at,
        )

    def get_context_trace(self, trace_id: str) -> ContextTrace:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM context_traces WHERE id = ?", (trace_id,)
            ).fetchone()
        if row is None:
            raise KeyError(trace_id)
        blocks = [ContextTraceBlock.model_validate(item) for item in _loads(row["blocks"], [])]
        return ContextTrace(
            id=row["id"],
            sessionId=row["session_id"],
            mode=row["mode"],
            characterId=row["character_id"],
            blocks=blocks,
            featureFlags=_loads(row["feature_flags"], {}),
            created_at=row["created_at"],
        )

    def _row_to_event(self, row: sqlite3.Row) -> CalendarEvent:
        return CalendarEvent(
            id=row["id"],
            title=row["title"],
            start=row["start"],
            end=row["end"],
            timezone=row["timezone"],
            location=row["location"],
            recurrence=row["recurrence"],
            metadata=_loads(row["metadata"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_task(self, row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            title=row["title"],
            dueAt=row["due_at"],
            timezone=row["timezone"],
            status=row["status"],
            priority=row["priority"],
            metadata=_loads(row["metadata"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_reminder(self, row: sqlite3.Row) -> Reminder:
        return Reminder(
            id=row["id"],
            title=row["title"],
            remindAt=row["remind_at"],
            timezone=row["timezone"],
            status=row["status"],
            eventId=row["event_id"],
            taskId=row["task_id"],
            metadata=_loads(row["metadata"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_event_delivery(self, row: sqlite3.Row) -> EventDelivery:
        return EventDelivery(
            id=row["id"],
            eventType=row["event_type"],
            resourceId=row["resource_id"],
            status=row["status"],
            attempts=row["attempts"],
            payload=_loads(row["payload"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            acknowledgedAt=row["acknowledged_at"],
            lastError=row["last_error"],
            claimedBy=row["claimed_by"],
            claimExpiresAt=row["claim_expires_at"],
        )

    def _row_to_character(self, row: sqlite3.Row) -> Character:
        return Character(
            id=row["id"],
            name=row["name"],
            persona=row["persona"],
            scenario=row["scenario"],
            tags=_loads(row["tags"], []),
            metadata=_loads(row["metadata"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_memory(self, row: sqlite3.Row) -> Memory:
        return Memory(
            id=row["id"],
            mode=row["mode"],
            sessionId=row["session_id"],
            characterId=row["character_id"],
            content=row["content"],
            tags=_loads(row["tags"], []),
            source=row["source"],
            created_at=row["created_at"],
        )

    def _row_to_confirmation(self, row: sqlite3.Row) -> ConfirmationRecord:
        return ConfirmationRecord(
            id=row["id"],
            actionType=row["action_type"],
            status=row["status"],
            reason=row["reason"],
            payload=_loads(row["payload"], {}),
            created_at=row["created_at"],
            decidedAt=row["decided_at"],
        )

    def _row_to_openai_config(self, row: sqlite3.Row) -> OpenAICompatibleConfig:
        api_key = row["api_key"] or ""
        return OpenAICompatibleConfig(
            provider=row["provider"],
            enabled=bool(row["enabled"]),
            baseUrl=row["base_url"],
            model=row["model"],
            apiKeySet=bool(api_key),
            apiKeyMasked=_mask_secret(api_key),
            headers=_loads(row["headers"], {}),
            temperature=row["temperature"],
            maxTokens=row["max_tokens"],
            contextWindowTokens=row["context_window_tokens"] or 128000,
            updated_at=row["updated_at"],
        )

    def _row_to_model_call_log(self, row: sqlite3.Row) -> ModelCallLog:
        return ModelCallLog(
            id=row["id"],
            provider=row["provider"],
            sessionId=row["session_id"],
            mode=row["mode"],
            characterId=row["character_id"],
            model=row["model"],
            endpoint=row["endpoint"],
            request=_loads(row["request_json"], {}),
            response=_loads(row["response_json"], {}),
            status=row["status"],
            error=row["error"],
            promptTokenEstimate=row["prompt_token_estimate"],
            completionText=row["completion_text"] or "",
            created_at=row["created_at"],
            completedAt=row["completed_at"],
        )


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"
