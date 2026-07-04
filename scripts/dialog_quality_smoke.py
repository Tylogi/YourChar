from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any


DEFAULT_NOW = "2026-07-04T12:00:00+08:00"
SMS_FORBIDDEN_TERMS = ("剧情", "角色", "叙事", "月光", "灯影", "酒馆")
RP_TOOL_CONFIRM_TERMS = ("已安排", "已设置提醒", "日程：", "任务：")


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class Report:
    base_url: str
    session_prefix: str
    checks: list[Check] = field(default_factory=list)
    samples: dict[str, Any] = field(default_factory=dict)

    def add(self, name: str, passed: bool, detail: str = "") -> None:
        self.checks.append(Check(name=name, passed=passed, detail=detail))

    @property
    def ok(self) -> bool:
        return all(check.passed for check in self.checks)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "baseUrl": self.base_url,
            "sessionPrefix": self.session_prefix,
            "checks": [check.__dict__ for check in self.checks],
            "samples": self.samples,
        }


class ApiClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None
        headers = {"accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} HTTP {exc.code}: {detail}") from exc
        return json.loads(raw) if raw else None

    def stream_message(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + f"/api/sessions/{urllib.parse.quote(session_id)}/messages/stream",
            data=data,
            headers={"content-type": "application/json", "accept": "text/event-stream"},
            method="POST",
        )
        final_response: dict[str, Any] | None = None
        deltas: list[str] = []
        with urllib.request.urlopen(req, timeout=90) as response:
            buffer = ""
            for raw in response:
                buffer += raw.decode("utf-8", errors="replace")
                frames = buffer.split("\n\n")
                buffer = frames.pop()
                for frame in frames:
                    event = _parse_sse_frame(frame)
                    if not event:
                        continue
                    if event.get("type") == "delta":
                        deltas.append(event.get("text") or "")
                    if event.get("type") == "error":
                        raise RuntimeError(event.get("detail") or "stream error")
                    if event.get("type") == "done":
                        final_response = event["response"]
            if buffer.strip():
                event = _parse_sse_frame(buffer)
                if event and event.get("type") == "done":
                    final_response = event["response"]
        if final_response is None:
            raise RuntimeError("stream completed without done event")
        final_response["_streamText"] = "".join(deltas)
        return final_response


def main() -> int:
    parser = argparse.ArgumentParser(description="Run API-level SMS/RP dialogue quality smoke tests.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument(
        "--suite",
        choices=("quick", "full"),
        default="quick",
        help="quick uses fewer external-model calls; full covers memory and schedule query flows",
    )
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON only")
    args = parser.parse_args()

    client = ApiClient(args.base_url)
    stamp = str(int(time.time()))
    report = Report(base_url=args.base_url, session_prefix=f"quality-{stamp}")

    try:
        run_checks(client, report, suite=args.suite)
    except Exception as exc:  # noqa: BLE001 - smoke script should report any transport failure.
        report.add("transport", False, str(exc))

    payload = report.as_dict()
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if report.ok else 1


def run_checks(client: ApiClient, report: Report, *, suite: str) -> None:
    health = client.request("GET", "/health")
    report.add("health", health == {"status": "ok"}, repr(health))

    model_config = client.request("GET", "/api/model-config/openai-compatible")
    report.add(
        "model_config:external_enabled",
        model_config.get("enabled") is True and bool(model_config.get("model")),
        f"enabled={model_config.get('enabled')} model={model_config.get('model')!r}",
    )

    features = client.request("GET", "/api/features")
    enabled = {item["name"]: item["enabled"] for item in features}
    for feature in ("calendar", "reminders", "characters", "rp_memory", "secretary_memory", "context_trace", "metrics"):
        report.add(f"feature:{feature}", enabled.get(feature) is True, f"enabled={enabled.get(feature)}")

    sms_session = report.session_prefix + "-sms"
    if suite == "full":
        sms_cases = [
            ("plain", "请用一句话确认收到。"),
            ("reminder", "三小时后提醒我喝水"),
            ("calendar", "今晚八点安排项目会"),
            ("memory", "请记住：我喜欢上午处理轻量会议"),
            ("memory_query", "我的会议偏好是什么？"),
            ("schedule_query", "今天有什么安排"),
        ]
        rp_texts = [
            "雨声里，我把一枚沾水的旧钥匙放到你的桌上。",
            "记住：明天晚上我要去龙塔议会，这是剧情里的安排。",
            "你继续以林岚的口吻回应我，保持克制，不要跳出角色。",
        ]
    else:
        sms_cases = [
            ("reminder", "三小时后提醒我喝水"),
            ("calendar", "今晚八点安排项目会"),
        ]
        rp_texts = [
            "雨声里，我把一枚沾水的旧钥匙放到你的桌上。",
        ]
    sms_responses: dict[str, dict[str, Any]] = {}
    for case_id, text in sms_cases:
        response = client.stream_message(
            sms_session,
            {"mode": "sms", "text": text, "now": DEFAULT_NOW, "timezone": "Asia/Shanghai"},
        )
        sms_responses[case_id] = _sample_response(response)
        reply = response["reply"]
        report.add(f"sms:{case_id}:concise", len(reply) <= 260, f"chars={len(reply)} reply={reply[:120]!r}")
        report.add(
            f"sms:{case_id}:no_rp_leak",
            not any(term in reply for term in SMS_FORBIDDEN_TERMS),
            reply[:160],
        )
        report.add(
            f"sms:{case_id}:no_internal_leak",
            not _looks_like_internal_leak(reply),
            reply[:200],
        )

    if "reminder" in sms_responses:
        report.add(
            "sms:reminder:action",
            _has_action(sms_responses["reminder"]["actions"], "create_reminder"),
            json.dumps(sms_responses["reminder"]["actions"], ensure_ascii=False),
        )
    if "calendar" in sms_responses:
        report.add(
            "sms:calendar:action",
            _has_action(sms_responses["calendar"]["actions"], "create_calendar"),
            json.dumps(sms_responses["calendar"]["actions"], ensure_ascii=False),
        )
    if "memory" in sms_responses:
        report.add(
            "sms:memory:action",
            _has_action(sms_responses["memory"]["actions"], "write_secretary_memory"),
            json.dumps(sms_responses["memory"]["actions"], ensure_ascii=False),
        )
    if "memory_query" in sms_responses:
        report.add(
            "sms:memory_query:no_write",
            not _has_action(sms_responses["memory_query"]["actions"], "write_secretary_memory"),
            json.dumps(sms_responses["memory_query"]["actions"], ensure_ascii=False),
        )

    character_id = report.session_prefix + "-archivist"
    character = client.request(
        "POST",
        "/api/characters",
        {
            "id": character_id,
            "name": "林岚",
            "persona": "冷静的档案管理员。说话克制，重视证据，不夸张，不跳脱。",
            "scenario": "深夜档案室，雨声很轻。角色正在整理一份被封存的旧案卷。",
            "tags": ["qa", "rp"],
            "metadata": {"source": "dialog_quality_smoke"},
        },
    )
    report.add("rp:character:create", character.get("id") == character_id, repr(character))

    rp_session = report.session_prefix + "-rp"
    rp_responses: list[dict[str, Any]] = []
    for index, text in enumerate(rp_texts, start=1):
        response = client.stream_message(
            rp_session,
            {
                "mode": "rp",
                "text": text,
                "now": DEFAULT_NOW,
                "timezone": "Asia/Shanghai",
                "characterId": character_id,
            },
        )
        rp_responses.append(response)
        reply = response["reply"]
        report.add(f"rp:turn{index}:not_empty", len(reply.strip()) >= 20, reply[:160])
        report.add(
            f"rp:turn{index}:no_real_tool_claim",
            not any(term in reply for term in RP_TOOL_CONFIRM_TERMS),
            reply[:160],
        )
        report.add(
            f"rp:turn{index}:no_internal_leak",
            not _looks_like_internal_leak(reply),
            reply[:200],
        )
        report.add(
            f"rp:turn{index}:memory_action",
            _has_action(response["actions"], "write_rp_memory"),
            json.dumps(response["actions"], ensure_ascii=False),
        )

    calendar = client.request("GET", "/api/calendar/events")
    report.add(
        "rp:isolation:no_story_calendar_pollution",
        not any("龙塔" in item.get("title", "") for item in calendar),
        json.dumps(calendar[-5:], ensure_ascii=False),
    )

    sms_logs = client.request(
        "GET",
        "/api/model-call-logs?limit=20&sessionId=" + urllib.parse.quote(sms_session),
    )
    rp_logs = client.request(
        "GET",
        "/api/model-call-logs?limit=20&sessionId=" + urllib.parse.quote(rp_session),
    )
    logs = [*sms_logs, *rp_logs]
    sms_log = _find_log(logs, sms_session)
    rp_log = _find_log(logs, rp_session)
    report.add("logs:sms:present", sms_log is not None, f"session logs inspected={len(sms_logs)}")
    report.add("logs:rp:present", rp_log is not None, f"session logs inspected={len(rp_logs)}")
    if sms_log:
        sms_system = "\n".join(m["content"] for m in sms_log["request"].get("messages", []) if m.get("role") == "system")
        report.add("logs:sms:secretary_prompt", "secretary agent" in sms_system, sms_system[:200])
        report.add("logs:sms:no_api_key", "authorization" not in json.dumps(sms_log).lower(), "")
    if rp_log:
        rp_system = "\n".join(m["content"] for m in rp_log["request"].get("messages", []) if m.get("role") == "system")
        report.add("logs:rp:roleplay_prompt", "roleplay agent" in rp_system, rp_system[:200])
        report.add("logs:rp:character_context", "林岚" in rp_system or "林岚" in json.dumps(rp_log, ensure_ascii=False), "")
        report.add(
            "logs:rp:reasoning_separate",
            rp_log["response"].get("reasoningContent", "") not in rp_log.get("completionText", ""),
            "reasoning is separate when present",
        )

    report.samples["sms"] = sms_responses
    report.samples["rp"] = [_sample_response(item) for item in rp_responses]


def _parse_sse_frame(frame: str) -> dict[str, Any] | None:
    data = "\n".join(
        line.removeprefix("data: ").strip()
        for line in frame.splitlines()
        if line.startswith("data:")
    )
    return json.loads(data) if data else None


def _has_action(actions: list[dict[str, Any]], action_type: str) -> bool:
    return any(action.get("actionType") == action_type for action in actions)


def _sample_response(response: dict[str, Any]) -> dict[str, Any]:
    return {
        "reply": response.get("reply", "")[:500],
        "actions": response.get("actions", []),
        "contextTraceId": response.get("contextTraceId"),
        "metrics": response.get("metrics"),
    }


def _find_log(logs: list[dict[str, Any]], session_id: str) -> dict[str, Any] | None:
    for log in logs:
        if log.get("sessionId") == session_id:
            return log
    return None


def _looks_like_internal_leak(reply: str) -> bool:
    stripped = reply.strip()
    if stripped.startswith(("{", "[")):
        return True
    forbidden = (
        "actionType",
        "modelCallLogId",
        "tool_calls",
        "Analyze the Request",
        "Output Generation",
        "Final Review",
        "chain of thought",
    )
    return any(term in stripped for term in forbidden)


if __name__ == "__main__":
    raise SystemExit(main())
