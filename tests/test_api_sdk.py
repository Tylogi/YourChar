import base64
import binascii
from datetime import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import struct
import threading
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from rp_agent_kernel.api import create_app
from rp_agent_kernel.kernel import Kernel
from rp_agent_kernel.models import CharacterCreate, MessageRequest, ReminderCreate
from rp_agent_kernel.sdk import InProcessKernelClient


NOW = datetime(2026, 7, 2, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai"))


def test_http_and_python_sdk_share_message_contract(tmp_path):
    app = create_app(str(tmp_path / "api.sqlite3"))
    http = TestClient(app)
    payload = {"mode": "sms", "text": "今晚八点安排项目会", "now": NOW.isoformat()}

    http_response = http.post("/api/sessions/s1/messages", json=payload)
    assert http_response.status_code == 200
    http_json = http_response.json()

    sdk = InProcessKernelClient(Kernel(":memory:"))
    sdk_json = sdk.sendMessage("s1", "sms", "今晚八点安排项目会", now=NOW)

    assert set(http_json) == set(sdk_json)
    assert http_json["reply"].startswith("已安排")
    assert sdk_json["reply"].startswith("已安排")
    assert http_json["actions"][0]["actionType"] == sdk_json["actions"][0]["actionType"]
    assert http_json["contextTraceId"]
    assert http_json["metrics"]["featureFlags"]["calendar"] is True


def test_temporary_ui_is_served(tmp_path):
    app = create_app(str(tmp_path / "ui.sqlite3"))
    client = TestClient(app)

    page = client.get("/ui")
    assert page.status_code == 200
    assert "Companion Kernel" in page.text
    assert "Inspector" in page.text
    assert "OpenAI Compatible API" in page.text
    assert "上传解析角色卡" in page.text
    assert "已有模型" in page.text
    assert "Model Logs" in page.text
    assert "20260704-round5" in page.text
    assert "chatContext" in page.text
    assert "newSessionBtn" in page.text
    assert "newSmsSessionBtn" in page.text
    assert "newRpSessionBtn" in page.text
    assert "copySessionBtn" in page.text
    assert "syncServerSessionsBtn" in page.text
    assert "cloneSessionBtn" in page.text
    assert "clearSessionBtn" in page.text
    assert "exportSessionEvalBtn" in page.text
    assert "sessionSearch" in page.text
    assert "sessionModeFilter" in page.text
    assert "sessionList" in page.text

    script = client.get("/ui/assets/app.js")
    assert script.status_code == 200
    assert "sendMessage" in script.text
    assert "streamApi" in script.text
    assert "loadHistory" in script.text
    assert "createNewSession" in script.text
    assert "copyCurrentSessionId" in script.text
    assert "syncServerSessions" in script.text
    assert "cloneCurrentSession" in script.text
    assert "clearCurrentSessionHistory" in script.text
    assert "exportCurrentSessionEvalCase" in script.text
    assert "attachRunSummary" in script.text
    assert "formatContextMetric" in script.text
    assert "formatEvalResult" in script.text
    assert "formatEvalCost" in script.text
    assert "captureRunSnapshot" in script.text
    assert "copyRunSummary" in script.text
    assert "exportRunEvalCase" in script.text
    assert "persistLatestRunArtifact" in script.text
    assert "getRunArtifact" in script.text
    assert "RUN_ARTIFACTS_KEY" in script.text
    assert "switchSession" in script.text
    assert "renderSessionList" in script.text
    assert "saveModelConfig" in script.text
    assert "importCharacterCard" in script.text
    assert "loadModelList" in script.text
    assert "saveCurrent" in script.text
    assert "selectModel" in script.text
    assert "modelSelect" in script.text
    assert "modelContextWindow" in script.text
    assert "loadModelLogs" in script.text
    assert "modelRoleBlock" in script.text
    assert "reasoning" in script.text
    assert "displayText" in script.text
    assert "sanitizeAssistantHistoryText" in script.text
    assert "hasDebugOpening" in script.text
    assert "debugHeadingCount" in script.text
    assert "formatActionSummary" in script.text
    assert "focusModelLog" in script.text
    assert "renderChatContext" in script.text
    assert "EVENT_CLIENT_ID" in script.text
    assert "startEventSubscription" in script.text
    assert "handleRuntimeEvent" in script.text
    assert "ackRuntimeEvent" in script.text
    assert "includePending" in script.text
    assert "intervalSeconds" in script.text
    assert 'nodes.fixedNow.value = saved.fixedNow || "";' in script.text
    assert 'nodes.fixedNow.value = saved.fixedNow || "2026-07-02T12:00";' not in script.text
    assert "SMS Secretary" not in script.text
    assert "RP Tavern" not in script.text
    assert "生活叙事视角" in script.text
    assert "消息视角" in script.text


def test_openai_compatible_config_masks_api_key(tmp_path):
    app = create_app(str(tmp_path / "model.sqlite3"))
    client = TestClient(app)

    default_config = client.get("/api/model-config/openai-compatible")
    assert default_config.status_code == 200
    assert default_config.json()["apiKeySet"] is False

    patched = client.patch(
        "/api/model-config/openai-compatible",
        json={
            "enabled": True,
            "baseUrl": "https://example.test/v1",
            "model": "compatible-model",
            "apiKey": "sk-test-secret-1234",
            "headers": {"X-Test": "1"},
            "temperature": 0.7,
            "maxTokens": 1024,
            "contextWindowTokens": 64000,
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["enabled"] is True
    assert body["apiKeySet"] is True
    assert body["apiKeyMasked"] == "sk-t...1234"
    assert "sk-test-secret-1234" not in json.dumps(body)

    fetched = client.get("/api/model-config/openai-compatible").json()
    assert fetched["baseUrl"] == "https://example.test/v1"
    assert fetched["model"] == "compatible-model"
    assert fetched["contextWindowTokens"] == 64000
    assert "sk-test-secret-1234" not in json.dumps(fetched)

    cleared = client.patch(
        "/api/model-config/openai-compatible",
        json={"clearApiKey": True},
    ).json()
    assert cleared["apiKeySet"] is False


def test_companion_profile_endpoint_shapes_context(tmp_path):
    app = create_app(str(tmp_path / "companion-profile.sqlite3"))
    client = TestClient(app)

    default_profile = client.get("/api/companion-profile")
    assert default_profile.status_code == 200
    assert default_profile.json()["name"] == "同行者"

    patched = client.patch(
        "/api/companion-profile",
        json={
            "name": "林岚",
            "practicalVoice": "简短、可靠、带一点熟悉感。",
            "immersiveVoice": "克制、细腻、像和用户共享同一条时间线。",
            "addressStyle": "自然称呼，不提系统模式。",
        },
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "林岚"

    response = client.post(
        "/api/sessions/profile-s1/messages",
        json={"mode": "sms", "text": "你好", "now": NOW.isoformat()},
    ).json()
    trace = client.get(f"/api/context-traces/{response['contextTraceId']}").json()
    persona = next(block for block in trace["blocks"] if block["source"] == "companion_persona")
    assert persona["tokenCount"] > 1


def test_debug_time_drives_messages_and_event_poll_when_now_is_omitted(tmp_path):
    app = create_app(str(tmp_path / "debug-time.sqlite3"))
    client = TestClient(app)

    default_state = client.get("/api/debug/time")
    assert default_state.status_code == 200
    assert default_state.json()["enabled"] is False

    patched = client.patch(
        "/api/debug/time",
        json={
            "enabled": True,
            "now": "2026-07-02T12:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    )
    assert patched.status_code == 200
    assert patched.json()["enabled"] is True

    created = client.post(
        "/api/sessions/debug-clock/messages",
        json={"mode": "sms", "text": "三小时后提醒我喝水"},
    ).json()
    assert "2026-07-02 15:00" in created["reply"]
    reminder = client.get("/api/reminders").json()[0]
    assert reminder["remindAt"] == "2026-07-02T15:00:00+08:00"

    client.patch("/api/debug/time", json={"now": "2026-07-02T15:00:00+08:00"})
    due = client.get("/api/events/poll", params={"clientId": "debug-test"}).json()
    assert due["count"] == 1
    assert due["events"][0]["type"] == "ReminderDue"
    assert due["events"][0]["delivery"]["claimedBy"] == "debug-test"

    cleared = client.patch("/api/debug/time", json={"clear": True}).json()
    assert cleared["enabled"] is False
    assert cleared["now"] is None


def test_ui_prefixed_api_routes_match_real_api(tmp_path):
    app = create_app(str(tmp_path / "ui-prefix.sqlite3"))
    client = TestClient(app)

    assert client.get("/ui/health").json() == {"status": "ok"}

    patched = client.patch(
        "/ui/api/model-config/openai-compatible",
        json={
            "enabled": True,
            "baseUrl": "http://example.test/v1",
            "apiKey": "client",
        },
    )
    assert patched.status_code == 200

    fetched = client.get("/ui/api/model-config/openai-compatible")
    assert fetched.status_code == 200
    assert fetched.json()["baseUrl"] == "http://example.test/v1"
    assert fetched.json()["apiKeySet"] is True


def test_model_call_logs_endpoint_lists_and_clears_logs(tmp_path):
    app = create_app(str(tmp_path / "model-logs.sqlite3"))
    client = TestClient(app)
    kernel = app.state.kernel

    log = kernel.storage.create_model_call_log(
        provider="openai_compatible",
        session_id="s1",
        mode="sms",
        character_id=None,
        model="debug-model",
        endpoint="http://example.test/v1/chat/completions",
        request={"model": "debug-model", "messages": [{"role": "system", "content": "rules"}]},
        prompt_token_estimate=3,
    )
    kernel.storage.complete_model_call_log(
        log.id,
        status="completed",
        response={"usage": {"total_tokens": 8}},
        completion_text="ok",
    )

    listed = client.get("/ui/api/model-call-logs")
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == log.id
    assert listed.json()[0]["request"]["messages"][0]["role"] == "system"
    assert "authorization" not in json.dumps(listed.json()).lower()

    fetched = client.get(f"/api/model-call-logs/{log.id}")
    assert fetched.status_code == 200
    assert fetched.json()["completionText"] == "ok"

    cleared = client.delete("/api/model-call-logs")
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] == 1
    assert client.get("/api/model-call-logs").json() == []


def test_stream_message_endpoint_returns_sse_events(tmp_path):
    app = create_app(str(tmp_path / "stream.sqlite3"))
    client = TestClient(app)

    response = client.post(
        "/ui/api/sessions/stream-s1/messages/stream",
        json={"mode": "sms", "text": "你好", "now": NOW.isoformat()},
    )
    assert response.status_code == 200
    events = _sse_events(response.text)

    assert events[0]["type"] == "start"
    assert events[0]["metrics"]["tokenEstimate"] > 0
    assert any(event["type"] == "delta" for event in events)
    assert events[-1]["type"] == "done"
    assert events[-1]["response"]["reply"] == "收到。"
    assert events[-1]["response"]["metrics"]["contextUsageRatio"] > 0


def test_due_event_poll_and_stream_are_shell_friendly_and_idempotent(tmp_path):
    app = create_app(str(tmp_path / "events.sqlite3"))
    client = TestClient(app)
    reminder = client.post(
        "/api/reminders",
        json={
            "title": "喝水",
            "remindAt": "2026-07-02T11:50:00+08:00",
            "metadata": {"sessionId": "sms-events", "mode": "sms"},
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "title": "提交周报",
            "dueAt": "2026-07-02T11:55:00+08:00",
            "metadata": {"sessionId": "sms-events", "mode": "sms"},
        },
    ).json()

    first = client.get("/api/events/poll", params={"now": NOW.isoformat()})
    assert first.status_code == 200
    body = first.json()
    assert body["count"] == 2
    types = {event["type"] for event in body["events"]}
    assert types == {"ReminderDue", "TaskOverdue"}
    reminder_event = next(event for event in body["events"] if event["type"] == "ReminderDue")
    task_event = next(event for event in body["events"] if event["type"] == "TaskOverdue")
    assert reminder_event["message"] == "我来提醒你：喝水。时间 2026-07-02 11:50。"
    assert reminder_event["sessionId"] == "sms-events"
    assert reminder_event["delivery"]["status"] == "claimed"
    assert reminder_event["delivery"]["claimedBy"] == "poll"
    assert reminder_event["delivery"]["claimExpiresAt"]
    assert reminder_event["eventDeliveryId"] == reminder_event["delivery"]["id"]
    assert reminder_event["action"]["actionType"] == "reminder_due"
    assert reminder_event["memory"]["source"] == "proactive_event"
    assert task_event["message"].startswith("我来提醒你：任务已逾期，提交周报。")
    assert task_event["action"]["actionType"] == "task_overdue"

    reminder_status = next(
        item for item in client.get("/api/reminders").json() if item["id"] == reminder["id"]
    )["status"]
    task_status = next(item for item in client.get("/api/tasks").json() if item["id"] == task["id"])[
        "status"
    ]
    assert reminder_status == "due"
    assert task_status == "overdue"
    second = client.get("/api/events/poll", params={"now": NOW.isoformat()})
    assert second.json() == {"events": [], "count": 0}

    streamed = client.get("/api/events/stream", params={"now": NOW.isoformat()})
    assert streamed.status_code == 200
    assert _sse_events(streamed.text) == [{"type": "Noop"}]


def test_runtime_tick_generates_pending_wake_event_for_sse_delivery(tmp_path):
    app = create_app(str(tmp_path / "runtime-tick.sqlite3"))
    client = TestClient(app)
    client.post(
        "/api/reminders",
        json={
            "title": "喝水",
            "remindAt": "2026-07-02T11:59:00+08:00",
            "metadata": {"sessionId": "runtime-s1", "mode": "sms"},
        },
    )

    tick = client.post("/api/runtime/tick", params={"now": NOW.isoformat()})
    assert tick.status_code == 200
    tick_body = tick.json()
    assert tick_body["count"] == 1
    assert tick_body["events"][0]["type"] == "ReminderDue"
    assert tick_body["events"][0]["delivery"]["status"] == "pending"

    pending = client.get("/api/events/pending").json()
    assert pending["count"] == 1
    assert pending["events"][0]["delivery"]["status"] == "pending"

    streamed = client.get(
        "/api/events/stream",
        params={"includePending": True, "clientId": "ui-sse", "leaseSeconds": 30},
    )
    assert streamed.status_code == 200
    events = _sse_events(streamed.text)
    assert len(events) == 1
    assert events[0]["type"] == "ReminderDue"
    assert events[0]["delivery"]["status"] == "claimed"
    assert events[0]["delivery"]["claimedBy"] == "ui-sse"
    assert events[0]["delivery"]["claimExpiresAt"]
    assert events[0]["eventDeliveryId"] == events[0]["delivery"]["id"]
    assert events[0]["sessionId"] == "runtime-s1"
    assert events[0]["mode"] == "sms"
    assert events[0]["message"]
    assert events[0]["action"]["actionType"] == "reminder_due"

    delivery_id = events[0]["eventDeliveryId"]
    wrong_client = client.post(
        f"/api/events/{delivery_id}/delivery",
        json={"status": "acked", "clientId": "other-ui"},
    )
    assert wrong_client.status_code == 409
    still_pending = client.get("/api/events/pending").json()
    assert still_pending["count"] == 1
    assert still_pending["events"][0]["delivery"]["status"] == "claimed"
    assert still_pending["events"][0]["delivery"]["claimedBy"] == "ui-sse"
    assert still_pending["events"][0]["delivery"]["acknowledgedAt"] is None

    acked = client.post(
        f"/api/events/{delivery_id}/delivery",
        json={"status": "acked", "clientId": "ui-sse"},
    ).json()
    assert acked["status"] == "acked"
    assert acked["acknowledgedAt"]
    assert client.get("/api/events/pending").json() == {"events": [], "count": 0}
    assert client.post(
        f"/api/events/{delivery_id}/delivery",
        json={"status": "acked", "clientId": "ui-sse"},
    ).json()["status"] == "acked"


def test_event_delivery_ack_and_failed_retry_are_agent_friendly(tmp_path):
    app = create_app(str(tmp_path / "event-delivery.sqlite3"))
    client = TestClient(app)
    client.post(
        "/api/reminders",
        json={
            "title": "伸展",
            "remindAt": "2026-07-02T11:59:00+08:00",
            "metadata": {"sessionId": "sms-delivery", "mode": "sms"},
        },
    )

    first_event = client.get("/api/events/poll", params={"now": NOW.isoformat()}).json()[
        "events"
    ][0]
    delivery_id = first_event["delivery"]["id"]
    pending = client.get("/api/events/pending").json()
    assert pending["count"] == 1
    assert pending["events"][0]["delivery"]["id"] == delivery_id
    assert pending["events"][0]["delivery"]["status"] == "claimed"

    assert client.post(
        f"/api/events/{delivery_id}/delivery", json={"status": "acked"}
    ).status_code == 409
    assert client.post(
        f"/api/events/{delivery_id}/delivery",
        json={"status": "acked", "clientId": "other-shell"},
    ).status_code == 409
    acked = client.post(
        f"/api/events/{delivery_id}/delivery",
        json={"status": "acked", "clientId": "poll"},
    ).json()
    assert acked["status"] == "acked"
    assert acked["acknowledgedAt"]
    assert client.get("/api/events/pending").json() == {"events": [], "count": 0}

    client.post(
        "/api/reminders",
        json={
            "title": "换水",
            "remindAt": "2026-07-02T11:58:00+08:00",
            "metadata": {"sessionId": "sms-delivery", "mode": "sms"},
        },
    )
    failed_event = client.get("/api/events/poll", params={"now": NOW.isoformat()}).json()[
        "events"
    ][0]
    failed_id = failed_event["delivery"]["id"]
    failed = client.post(
        f"/api/events/{failed_id}/delivery",
        json={"status": "failed", "error": "shell closed", "clientId": "poll"},
    ).json()
    assert failed["status"] == "failed"
    assert failed["lastError"] == "shell closed"

    assert client.get("/api/events/poll", params={"now": NOW.isoformat()}).json() == {
        "events": [],
        "count": 0,
    }
    retry = client.get(
        "/api/events/poll",
        params={"now": NOW.isoformat(), "includePending": True},
    ).json()
    assert retry["count"] == 1
    assert retry["events"][0]["delivery"]["status"] == "claimed"
    assert retry["events"][0]["delivery"]["attempts"] == 2
    assert retry["events"][0]["delivery"]["lastError"] == "shell closed"
    retry_ack = client.post(
        f"/api/events/{failed_id}/delivery", json={"status": "acked", "clientId": "poll"}
    ).json()
    assert retry_ack["status"] == "acked"
    assert retry_ack["attempts"] == 2
    assert retry_ack["lastError"] is None
    assert client.post(
        f"/api/events/{failed_id}/delivery",
        json={"status": "failed", "error": "too late"},
    ).status_code == 409


def test_inprocess_sdk_can_ack_claimed_event_delivery():
    kernel = Kernel(":memory:")
    sdk = InProcessKernelClient(kernel)
    try:
        kernel.storage.create_reminder(
            ReminderCreate(
                title="喝水",
                remindAt=datetime(2026, 7, 2, 11, 59, tzinfo=ZoneInfo("Asia/Shanghai")),
                metadata={"sessionId": "sdk-events", "mode": "sms"},
            )
        )
        event = kernel.due_events(NOW, client_id="python-sdk")[0]

        acked = sdk.ackEvent(event["eventDeliveryId"], clientId="python-sdk")

        assert acked["status"] == "acked"
        assert acked["id"] == event["eventDeliveryId"]
    finally:
        kernel.close()


def test_inprocess_sdk_subscribe_events_claims_and_acks_delivery():
    kernel = Kernel(":memory:")
    sdk = InProcessKernelClient(kernel)
    try:
        kernel.storage.create_reminder(
            ReminderCreate(
                title="站起来活动",
                remindAt=datetime(2020, 1, 1, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
                metadata={"sessionId": "sdk-subscribe", "mode": "sms"},
            )
        )
        seen: list[dict] = []

        events = list(
            sdk.subscribeEvents(
                seen.append,
                follow=False,
                includePending=True,
                clientId="sdk-subscribe",
                leaseSeconds=30,
                intervalSeconds=1,
            )
        )

        assert len(events) == 1
        assert seen == events
        event = events[0]
        assert event["type"] == "ReminderDue"
        assert event["sessionId"] == "sdk-subscribe"
        assert event["eventDeliveryId"] == event["delivery"]["id"]
        assert event["delivery"]["status"] == "claimed"
        assert event["delivery"]["claimedBy"] == "sdk-subscribe"
        assert event["memoryPolicy"]["useAsPlotFact"] is False

        acked = sdk.ackEvent(event["eventDeliveryId"], clientId="sdk-subscribe")
        assert acked["status"] == "acked"
    finally:
        kernel.close()


def test_sdk_sources_expose_runtime_subscription_interval_option():
    python_source = Path("src/rp_agent_kernel/sdk/python.py").read_text()
    ts_source = Path("sdk/typescript/index.ts").read_text()

    assert "intervalSeconds" in python_source
    assert '"intervalSeconds": intervalSeconds' in python_source
    assert "intervalSeconds?: number" in ts_source
    assert "options.intervalSeconds ?? 5" in ts_source


def test_event_delivery_claim_lease_prevents_parallel_notifications(tmp_path):
    app = create_app(str(tmp_path / "event-lease.sqlite3"))
    client = TestClient(app)
    client.post(
        "/api/reminders",
        json={
            "title": "站会",
            "remindAt": "2026-07-02T11:59:00+08:00",
            "metadata": {"sessionId": "sms-lease", "mode": "sms"},
        },
    )

    first = client.get(
        "/api/events/poll",
        params={
            "now": NOW.isoformat(),
            "clientId": "shell-a",
            "leaseSeconds": 10,
        },
    ).json()
    assert first["count"] == 1
    delivery = first["events"][0]["delivery"]
    assert delivery["status"] == "claimed"
    assert delivery["claimedBy"] == "shell-a"
    assert delivery["attempts"] == 1

    parallel = client.get(
        "/api/events/poll",
        params={
            "now": NOW.isoformat(),
            "includePending": True,
            "clientId": "shell-b",
            "leaseSeconds": 10,
        },
    ).json()
    assert parallel == {"events": [], "count": 0}

    reclaimed = client.get(
        "/api/events/poll",
        params={
            "now": "2026-07-02T12:00:11+08:00",
            "includePending": True,
            "clientId": "shell-b",
            "leaseSeconds": 10,
        },
    ).json()
    assert reclaimed["count"] == 1
    reclaimed_delivery = reclaimed["events"][0]["delivery"]
    assert reclaimed_delivery["claimedBy"] == "shell-b"
    assert reclaimed_delivery["attempts"] == 2


def test_due_time_comparison_uses_absolute_time_across_offsets(tmp_path):
    app = create_app(str(tmp_path / "offsets.sqlite3"))
    client = TestClient(app)
    client.post(
        "/api/reminders",
        json={
            "title": "不该提前触发",
            "remindAt": "2026-07-02T00:30:00-04:00",
            "metadata": {"sessionId": "sms-offset", "mode": "sms"},
        },
    )

    too_early = client.get("/api/events/poll", params={"now": NOW.isoformat()}).json()
    assert too_early == {"events": [], "count": 0}

    due = client.get(
        "/api/events/poll",
        params={"now": "2026-07-02T12:31:00+08:00"},
    ).json()
    assert due["count"] == 1
    assert due["events"][0]["type"] == "ReminderDue"


def test_rp_due_reminder_uses_character_voice_and_memory(tmp_path):
    app = create_app(str(tmp_path / "rp-events.sqlite3"))
    client = TestClient(app)
    character = client.post(
        "/api/characters",
        json={
            "id": "archivist",
            "name": "林岚",
            "persona": "冷静的档案管理员。",
            "scenario": "雨夜档案室。",
        },
    ).json()
    client.post(
        "/api/reminders",
        json={
            "title": "喝水",
            "remindAt": "2026-07-02T11:50:00+08:00",
            "metadata": {
                "sessionId": "rp-events",
                "mode": "rp",
                "characterId": character["id"],
            },
        },
    )

    event = client.get("/api/events/poll", params={"now": NOW.isoformat()}).json()["events"][0]
    assert event["type"] == "ReminderDue"
    assert event["mode"] == "rp"
    assert event["characterId"] == "archivist"
    assert "林岚" in event["message"]
    assert "冷静" in event["message"]
    assert "现实提醒" in event["message"]
    assert event["memoryPolicy"]["useAsPlotFact"] is False
    assert event["memory"]["mode"] == "rp"
    assert event["memory"]["characterId"] == "archivist"
    assert event["memory"]["source"] == "proactive_event"
    assert "out_of_character" in event["memory"]["tags"]


def test_rp_message_created_reminder_triggers_life_narrative_due_event(tmp_path):
    app = create_app(str(tmp_path / "rp-message-reminder.sqlite3"))
    client = TestClient(app)
    character = client.post(
        "/api/characters",
        json={
            "id": "linlan",
            "name": "林岚",
            "persona": "冷静的档案管理员。",
            "scenario": "雨夜档案室。",
        },
    ).json()

    created = client.post(
        "/api/sessions/rp-message-reminder/messages",
        json={
            "mode": "rp",
            "text": "三小时后提醒我喝水",
            "now": NOW.isoformat(),
            "characterId": character["id"],
        },
    ).json()
    assert any(action["actionType"] == "create_reminder" for action in created["actions"])
    assert "她把提醒写进现实清单" in created["reply"]

    event = client.get(
        "/api/events/poll",
        params={"now": "2026-07-02T15:00:00+08:00"},
    ).json()["events"][0]
    assert event["type"] == "ReminderDue"
    assert event["mode"] == "rp"
    assert event["sessionId"] == "rp-message-reminder"
    assert event["characterId"] == "linlan"
    assert "林岚" in event["message"]
    assert "现实提醒" in event["message"]
    assert event["memoryPolicy"]["useAsPlotFact"] is False
    assert event["memory"]["source"] == "proactive_event"
    assert "out_of_character" in event["memory"]["tags"]


def test_rp_proactive_memory_is_not_default_plot_context(tmp_path):
    kernel = Kernel(str(tmp_path / "rp-context.sqlite3"))
    try:
        kernel.storage.create_character(
            CharacterCreate(
                id="archivist",
                name="林岚",
                persona="冷静的档案管理员。",
                scenario="雨夜档案室。",
            )
        )
        content = "现实提醒触发（不作为剧情事实）：主动提醒已触发：喝水"
        kernel.storage.add_memory(
            mode="rp",
            session_id="rp-context",
            character_id="archivist",
            content=content,
            tags=["proactive", "reminder", "real_world", "out_of_character"],
            source="proactive_event",
        )

        normal = kernel.context_builder.build(
            "rp-context",
            MessageRequest(mode="rp", text="继续刚才的剧情", now=NOW, characterId="archivist"),
        )
        normal_rp_memory = next(block for block in normal.blocks if block.source == "memories.rp")
        assert normal_rp_memory.hash == hashlib.sha256("No RP memory.".encode()).hexdigest()
        explicit = kernel.context_builder.build(
            "rp-context",
            MessageRequest(mode="rp", text="现实提醒有哪些", now=NOW, characterId="archivist"),
        )
        rp_memory_block = next(block for block in explicit.blocks if block.source == "memories.rp")
        assert rp_memory_block.hash == hashlib.sha256(content.encode()).hexdigest()
    finally:
        kernel.close()


def test_openai_compatible_model_list_endpoint(tmp_path):
    server, handler, thread = _start_model_list_server()
    app = create_app(str(tmp_path / "model-list.sqlite3"))
    client = TestClient(app)
    try:
        client.patch(
            "/api/model-config/openai-compatible",
            json={
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "apiKey": "sk-test",
                "model": "alpha-model",
            },
        )

        response = client.get("/api/model-config/openai-compatible/models")
        assert response.status_code == 200
        assert response.json() == {"models": ["alpha-model", "beta-model"], "count": 2}
        assert handler.calls == 1
        assert handler.last_path == "/v1/models"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_character_card_json_import_endpoint(tmp_path):
    app = create_app(str(tmp_path / "character-json.sqlite3"))
    client = TestClient(app)

    card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "璃月",
            "description": "冷静的档案管理员。",
            "personality": "说话克制，重视证据。",
            "scenario": "深夜资料室。",
            "tags": ["archive", "rp"],
            "first_mes": "你终于来了。",
        },
    }
    response = client.post(
        "/api/characters/import-card",
        json={"fileName": "liyue.json", "content": json.dumps(card, ensure_ascii=False)},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["parsedFormat"] == "chara_card_v2"
    assert data["character"]["name"] == "璃月"
    assert "冷静的档案管理员" in data["character"]["persona"]
    assert data["character"]["scenario"] == "深夜资料室。"
    assert data["character"]["metadata"]["first_mes"] == "你终于来了。"


def test_character_card_png_import_endpoint(tmp_path):
    app = create_app(str(tmp_path / "character-png.sqlite3"))
    client = TestClient(app)

    card = {"data": {"name": "PNG角色", "description": "来自 PNG metadata。"}}
    png = _png_with_text("chara", base64.b64encode(json.dumps(card).encode()).decode())
    response = client.post(
        "/api/characters/import-card",
        json={"fileName": "card.png", "contentBase64": base64.b64encode(png).decode()},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["parsedFormat"] == "tavern_png"
    assert data["character"]["name"] == "PNG角色"
    assert "PNG metadata" in data["character"]["persona"]


def test_session_history_endpoint_returns_recent_messages(tmp_path):
    app = create_app(str(tmp_path / "history.sqlite3"))
    client = TestClient(app)

    sent = client.post(
        "/api/sessions/history-s1/messages",
        json={"mode": "sms", "text": "今晚八点安排项目会", "now": NOW.isoformat()},
    )
    assert sent.status_code == 200

    history = client.get("/api/sessions/history-s1/messages?limit=10")
    assert history.status_code == 200
    messages = history.json()
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "今晚八点安排项目会"
    assert messages[0]["mode"] == "sms"
    assert "id" in messages[0]


def test_session_workbench_endpoints_list_clone_and_clear(tmp_path):
    app = create_app(str(tmp_path / "sessions.sqlite3"))
    client = TestClient(app)

    client.post(
        "/api/sessions/workbench-sms/messages",
        json={"mode": "sms", "text": "今晚八点安排项目会", "now": NOW.isoformat()},
    )
    client.post(
        "/api/sessions/workbench-rp/messages",
        json={"mode": "rp", "text": "月光下，角色推开门。", "now": NOW.isoformat()},
    )

    listed = client.get("/api/sessions?search=workbench&limit=10")
    assert listed.status_code == 200
    session_ids = {item["sessionId"] for item in listed.json()}
    assert {"workbench-sms", "workbench-rp"} <= session_ids
    sms_only = client.get("/api/sessions?mode=sms&search=workbench").json()
    assert [item["sessionId"] for item in sms_only] == ["workbench-sms"]
    assert sms_only[0]["messageCount"] == 2
    assert sms_only[0]["lastPreview"]

    cloned = client.post(
        "/api/sessions/workbench-sms/clone",
        json={"targetSessionId": "workbench-sms-copy"},
    )
    assert cloned.status_code == 200
    assert cloned.json()["cloned"] == 2
    clone_history = client.get("/api/sessions/workbench-sms-copy/messages").json()
    assert [message["role"] for message in clone_history] == ["user", "assistant"]

    cleared = client.delete("/api/sessions/workbench-sms-copy/messages")
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] == 2
    assert client.get("/api/sessions/workbench-sms-copy/messages").json() == []


def _png_with_text(keyword: str, value: str) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    text_data = keyword.encode("latin-1") + b"\x00" + value.encode("latin-1")
    return (
        signature
        + _png_chunk(b"IHDR", ihdr_data)
        + _png_chunk(b"tEXt", text_data)
        + _png_chunk(b"IEND", b"")
    )


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


class _ModelListHandler(BaseHTTPRequestHandler):
    calls = 0
    last_path = ""

    def do_GET(self):
        type(self).calls += 1
        type(self).last_path = self.path
        body = json.dumps(
            {"data": [{"id": "beta-model"}, {"id": "alpha-model"}, {"id": "alpha-model"}]}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def _start_model_list_server():
    handler = type("ConfiguredModelListHandler", (_ModelListHandler,), {"calls": 0, "last_path": ""})
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, handler, thread


def _sse_events(text: str) -> list[dict]:
    events: list[dict] = []
    for frame in text.strip().split("\n\n"):
        data = "\n".join(
            line.removeprefix("data: ").strip()
            for line in frame.splitlines()
            if line.startswith("data:")
        )
        if data:
            events.append(json.loads(data))
    return events


def test_feature_endpoint_is_agent_test_friendly(tmp_path):
    app = create_app(str(tmp_path / "features.sqlite3"))
    client = TestClient(app)

    features = client.get("/api/features")
    assert features.status_code == 200
    assert any(item["name"] == "calendar" for item in features.json())

    patched = client.patch("/api/features", json={"flags": {"calendar": False}})
    assert patched.status_code == 200
    assert next(item for item in patched.json() if item["name"] == "calendar")["enabled"] is False

    blocked = client.get("/api/calendar/events")
    assert blocked.status_code == 403

    message = client.post(
        "/api/sessions/s1/messages",
        json={"mode": "sms", "text": "今晚八点安排项目会", "now": NOW.isoformat()},
    )
    assert message.status_code == 200
    assert message.json()["actions"][0]["status"] == "feature_disabled"


def test_eval_capabilities_and_run_endpoint(tmp_path):
    app = create_app(str(tmp_path / "eval.sqlite3"))
    client = TestClient(app)

    capabilities = client.get("/api/eval/capabilities")
    assert capabilities.status_code == 200
    assert "POST /api/eval/run" in capabilities.json()["endpoints"]
    assert "POST /api/runtime/tick" in capabilities.json()["endpoints"]
    assert "setFeature(name, enabled)" in capabilities.json()["sdkMethods"]
    assert "ackEvent(deliveryId)" in capabilities.json()["sdkMethods"]
    prompt_layout = capabilities.json()["promptLayout"]
    assert prompt_layout["externalModel"] == "cache-friendly-v1"
    assert prompt_layout["dynamicContextRole"] == "user"
    assert "system:stable-render-contract" in prompt_layout["messageOrder"]
    assert "user:dynamic-runtime-context-and-current-message" in prompt_layout["messageOrder"]
    assert "think_tags" in prompt_layout["reasoningFormats"]

    response = client.post(
        "/api/eval/run",
        json={
            "cases": [
                {
                    "id": "sms-reminder",
                    "sessionId": "eval-s1",
                    "request": {
                        "mode": "sms",
                        "text": "三小时后提醒我喝水",
                        "now": NOW.isoformat(),
                    },
                    "assertions": {
                        "actionType": "create_reminder",
                        "replyContains": "已设置提醒",
                        "maxContextUsageRatio": 0.1,
                        "maxTokenEstimate": 2000,
                        "maxGeneratedTokens": 80,
                    },
                }
            ]
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["deterministic"] is True
    assert data["summary"]["passed"] == 1
    assert data["summary"]["maxTokenEstimate"] > 0
    assert data["summary"]["maxContextUsageRatio"] > 0
    assert data["summary"]["meanContextUsageRatio"] > 0
    assert data["summary"]["totalGeneratedTokens"] > 0
    assert data["summary"]["cost"]["status"] == "unknown"
    assert data["summary"]["cost"]["totalTokens"] > 0
    assert data["results"][0]["response"]["metrics"]["latencyMs"] >= 0
    assert data["results"][0]["response"]["metrics"]["generatedTokens"] > 0
    assert data["results"][0]["assertionResults"]["maxContextUsageRatio"] is True
    assert data["results"][0]["assertionResults"]["maxGeneratedTokens"] is True
