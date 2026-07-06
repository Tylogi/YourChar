from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import threading
import time
from zoneinfo import ZoneInfo

from rp_agent_kernel.kernel import Kernel
from rp_agent_kernel.models import (
    CalendarEventCreate,
    CharacterCreate,
    ConfirmationDecision,
    FeatureName,
    MessageRequest,
    OpenAICompatibleConfigPatch,
    ReminderCreate,
)


NOW = datetime(2026, 7, 2, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai"))


def test_context_stable_prefix_hash_survives_dynamic_schedule_changes():
    kernel = Kernel(":memory:")
    try:
        first = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="今天有什么安排", now=NOW)
        )
        kernel.storage.create_event(
            CalendarEventCreate(
                title="项目会",
                start=datetime(2026, 7, 2, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        second = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="今天有什么安排", now=NOW)
        )

        trace1 = kernel.storage.get_context_trace(first.context_trace_id)
        trace2 = kernel.storage.get_context_trace(second.context_trace_id)
        stable1 = {block.id: block.hash for block in trace1.blocks if block.layer == "stable"}
        stable2 = {block.id: block.hash for block in trace2.blocks if block.layer == "stable"}
        assert stable1 == stable2
        assert any(block.source == "calendar_events" for block in trace2.blocks)
    finally:
        kernel.close()


def test_rp_memory_does_not_pollute_sms_schedule_judgment():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_character(
            CharacterCreate(id="mage", name="Mage", persona="A careful archivist.")
        )
        rp = kernel.handle_message(
            "s1",
            MessageRequest(
                mode="rp",
                text="记住：明天晚上我要去龙塔会议，这是剧情里的安排。",
                now=NOW,
                characterId="mage",
            ),
        )
        assert any(action.action_type == "write_rp_memory" for action in rp.actions)
        assert kernel.storage.list_events() == []

        sms = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="明天有什么安排", now=NOW)
        )
        assert "龙塔" not in sms.reply
        trace = kernel.storage.get_context_trace(sms.context_trace_id)
        assert all(block.source != "memories.rp" for block in trace.blocks)
    finally:
        kernel.close()


def test_rp_records_shared_timeline_without_real_tool_pollution():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_character(
            CharacterCreate(id="linlan", name="林岚", persona="冷静的档案管理员。")
        )
        rp = kernel.handle_message(
            "shared-1",
            MessageRequest(
                mode="rp",
                text="雨夜里，我们把旧档案重新封好，没有继续追问。",
                now=NOW,
                characterId="linlan",
            ),
        )
        assert any(action.action_type == "record_shared_episode" for action in rp.actions)
        episodes = kernel.storage.list_shared_episodes(
            session_id="shared-1", character_id="linlan"
        )
        assert len(episodes) == 1
        assert "雨夜" in episodes[0].summary
        assert episodes[0].usable_for_real_world_tools is False
        assert episodes[0].reality_scope == "shared_experience"
        assert kernel.storage.list_events() == []

        sms = kernel.handle_message(
            "shared-1", MessageRequest(mode="sms", text="今天有什么安排", now=NOW)
        )
        assert "我还记得刚才那段" in sms.reply
        assert "雨夜" not in sms.reply
        sms_trace = kernel.storage.get_context_trace(sms.context_trace_id)
        assert any(block.source == "shared_timeline" for block in sms_trace.blocks)

        practical = kernel.handle_message(
            "shared-1", MessageRequest(mode="sms", text="收到", now=NOW)
        )
        assert "雨夜" in practical.reply

        rp_again = kernel.handle_message(
            "shared-1",
            MessageRequest(mode="rp", text="我们继续。", now=NOW, characterId="linlan"),
        )
        rp_trace = kernel.storage.get_context_trace(rp_again.context_trace_id)
        timeline_block = next(block for block in rp_trace.blocks if block.source == "shared_timeline")
        assert timeline_block.token_count > 1
    finally:
        kernel.close()


def test_secretary_memory_query_does_not_write_new_memory():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.add_memory(
            mode="sms",
            session_id="s1",
            character_id=None,
            content="会议偏好：25 分钟线上会议。",
            tags=["preference"],
        )
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="我的会议偏好是什么？", now=NOW)
        )

        assert all(action.action_type != "write_secretary_memory" for action in response.actions)
        memories = kernel.storage.recent_memories(mode="sms", session_id="s1", limit=5)
        assert [memory.content for memory in memories] == ["会议偏好：25 分钟线上会议。"]
    finally:
        kernel.close()


def test_rp_context_excludes_real_state_until_explicit_real_request():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_event(
            CalendarEventCreate(
                title="现实项目会",
                start=datetime(2026, 7, 2, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        kernel.storage.create_reminder(
            ReminderCreate(
                title="现实喝水",
                remindAt=datetime(2026, 7, 2, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        kernel.storage.create_character(
            CharacterCreate(id="archive", name="Archive", persona="A careful archivist.")
        )

        rp = kernel.handle_message(
            "rp1",
            MessageRequest(mode="rp", text="旧钥匙落在桌上。", now=NOW, characterId="archive"),
        )
        rp_trace = kernel.storage.get_context_trace(rp.context_trace_id)
        assert all(block.source != "calendar_events" for block in rp_trace.blocks)
        assert all(block.source != "reminders" for block in rp_trace.blocks)
        shared_reality = next(block for block in rp_trace.blocks if block.source == "shared_reality")
        assert shared_reality.token_count > 1

        real = kernel.handle_message(
            "rp1",
            MessageRequest(mode="rp", text="/real 今天有什么安排", now=NOW, characterId="archive"),
        )
        real_trace = kernel.storage.get_context_trace(real.context_trace_id)
        assert any(block.source == "calendar_events" for block in real_trace.blocks)
        assert any(block.source == "reminders" for block in real_trace.blocks)
    finally:
        kernel.close()


def test_reality_projection_feature_flag_controls_rp_shared_present():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_event(
            CalendarEventCreate(
                title="现实项目会",
                start=datetime(2026, 7, 2, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        kernel.storage.create_character(
            CharacterCreate(id="archive", name="Archive", persona="A careful archivist.")
        )
        enabled = kernel.handle_message(
            "rp-reality",
            MessageRequest(mode="rp", text="旧钥匙落在桌上。", now=NOW, characterId="archive"),
        )
        enabled_trace = kernel.storage.get_context_trace(enabled.context_trace_id)
        assert any(block.source == "shared_reality" for block in enabled_trace.blocks)
        assert all(block.source != "calendar_events" for block in enabled_trace.blocks)

        kernel.storage.set_features({FeatureName.reality_projection: False})
        disabled = kernel.handle_message(
            "rp-reality",
            MessageRequest(mode="rp", text="继续。", now=NOW, characterId="archive"),
        )
        disabled_trace = kernel.storage.get_context_trace(disabled.context_trace_id)
        assert all(block.source != "shared_reality" for block in disabled_trace.blocks)
    finally:
        kernel.close()


def test_mode_behavior_sms_short_rp_immersive():
    kernel = Kernel(":memory:")
    try:
        sms = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="今晚八点安排项目会", now=NOW)
        )
        assert any(action.action_type == "create_calendar" for action in sms.actions)
        assert sms.reply.startswith("已安排")
        assert len(sms.reply) < 80

        rp = kernel.handle_message(
            "s2", MessageRequest(mode="rp", text="月光下，角色推开门。", now=NOW)
        )
        assert any(action.action_type == "write_rp_memory" for action in rp.actions)
        assert len(rp.reply) > 80
    finally:
        kernel.close()


def test_reminder_flow_for_relative_time():
    kernel = Kernel(":memory:")
    try:
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="三小时后提醒我喝水", now=NOW)
        )
        assert any(action.action_type == "create_reminder" for action in response.actions)
        reminders = kernel.storage.list_reminders()
        assert reminders[0].title == "喝水"
        assert reminders[0].remind_at.isoformat() == "2026-07-02T15:00:00+08:00"
    finally:
        kernel.close()


def test_tool_safety_requires_confirmation_for_bulk_delete():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_event(
            CalendarEventCreate(
                title="项目会",
                start=datetime(2026, 7, 2, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="删除所有日程", now=NOW)
        )
        assert response.confirmations
        assert response.actions[0].status == "confirmation_required"
        assert len(kernel.storage.list_events()) == 1

        confirmed = kernel.confirm_action(
            response.confirmations[0].id, ConfirmationDecision(decision="approved")
        )
        assert confirmed.actions[0].status == "completed"
        assert kernel.storage.list_events() == []
    finally:
        kernel.close()


def test_feature_flag_disables_calendar_independently():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.set_features({FeatureName.calendar: False})
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="今晚八点安排项目会", now=NOW)
        )
        assert response.actions[0].status == "feature_disabled"
        assert kernel.storage.list_events() == []
        assert response.metrics.feature_flags["calendar"] is False
    finally:
        kernel.close()


def test_fts_search_flag_controls_retrieval_context_block():
    kernel = Kernel(":memory:")
    try:
        kernel.storage.add_memory(
            mode="sms",
            session_id="s1",
            character_id=None,
            content="偏好：上午处理轻量会议。",
            tags=["preference"],
        )
        enabled = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="会议偏好是什么", now=NOW)
        )
        enabled_trace = kernel.storage.get_context_trace(enabled.context_trace_id)
        assert any(block.source == "memory_search" for block in enabled_trace.blocks)

        kernel.storage.set_features({FeatureName.fts_search: False})
        disabled = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="会议偏好是什么", now=NOW)
        )
        disabled_trace = kernel.storage.get_context_trace(disabled.context_trace_id)
        assert all(block.source != "memory_search" for block in disabled_trace.blocks)
    finally:
        kernel.close()


def test_eval_runner_reports_assertions_and_latency_metrics():
    kernel = Kernel(":memory:")
    try:
        result = kernel.run_eval(
            {
                "cases": [
                    {
                        "id": "sms-create-event",
                        "sessionId": "eval-s1",
                        "request": {
                            "mode": "sms",
                            "text": "今晚八点安排项目会",
                            "now": NOW.isoformat(),
                        },
                        "assertions": {
                            "replyContains": "已安排",
                            "actionType": "create_calendar",
                            "contextTracePresent": True,
                            "maxLatencyMs": 1000,
                        },
                    }
                ]
            }
        )
        assert result.summary["passed"] == 1
        assert result.results[0].passed is True
        assert result.results[0].response.metrics.latency_ms >= 0
    finally:
        kernel.close()


def test_external_model_renders_reply_when_config_enabled():
    server, handler, thread = _start_fake_openai_server(
        {"choices": [{"message": {"content": "外部模型回复"}}], "usage": {"total_tokens": 9}}
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="fake-model",
            )
        )
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="你好", now=NOW)
        )
        assert response.reply == "外部模型回复"
        assert any(
            action.action_type == "external_model_render" and action.status == "completed"
            for action in response.actions
        )
        assert handler.calls == 1
        assert handler.last_path == "/v1/chat/completions"
        assert handler.last_body["model"] == "fake-model"
        assert handler.last_body["messages"][-1] == {"role": "user", "content": "你好"}
        assert "one continuous companion" in handler.last_body["messages"][0]["content"]
        assert "practical posture" in handler.last_body["messages"][0]["content"]
        system_prompt = "\n".join(
            message["content"]
            for message in handler.last_body["messages"]
            if message["role"] == "system"
        )
        assert "Companion identity:" in system_prompt
        assert "name: 同行者" in system_prompt
        completed = next(
            action for action in response.actions if action.action_type == "external_model_render"
        )
        log_id = completed.payload["modelCallLogId"]
        log = kernel.storage.get_model_call_log(log_id)
        assert log.status == "completed"
        assert log.request["messages"][-1] == {"role": "user", "content": "你好"}
        assert log.completion_text == "外部模型回复"
        assert "test-key" not in json.dumps(log.model_dump(mode="json", by_alias=True))
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_rp_prompt_uses_read_only_shared_present_by_default():
    server, handler, thread = _start_fake_openai_server(
        {"choices": [{"message": {"content": "角色回复"}}], "usage": {"total_tokens": 9}}
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.create_event(
            CalendarEventCreate(
                title="现实项目会",
                start=datetime(2026, 7, 2, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        kernel.storage.create_reminder(
            ReminderCreate(
                title="现实喝水",
                remindAt=datetime(2026, 7, 2, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
        )
        kernel.storage.create_character(
            CharacterCreate(id="archive", name="Archive", persona="A careful archivist.")
        )
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="fake-model",
            )
        )
        response = kernel.handle_message(
            "rp1",
            MessageRequest(mode="rp", text="旧钥匙落在桌上。", now=NOW, characterId="archive"),
        )

        assert response.reply == "角色回复"
        prompt = "\n".join(
            message["content"]
            for message in handler.last_body["messages"]
            if message["role"] == "system"
        )
        assert "Upcoming real-world calendar events" not in prompt
        assert "Reminders:" not in prompt
        assert "Shared present (read-only, for tone/pacing only):" in prompt
        assert "near_calendar=20:00 现实项目会" in prompt
        assert "near_reminder=15:00 现实喝水" in prompt
        assert "not as tool result or plot fact" in prompt
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_streaming_emits_metrics_and_final_response():
    server, handler, thread = _start_fake_openai_stream_server(["流", "式回复"])
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="fake-model",
                contextWindowTokens=64000,
            )
        )
        events = list(
            kernel.stream_message_events(
                "s1", MessageRequest(mode="sms", text="你好", now=NOW)
            )
        )

        assert [event["type"] for event in events[:3]] == ["start", "delta", "delta"]
        assert events[0]["metrics"]["contextWindowTokens"] == 64000
        assert events[-1]["type"] == "done"
        response = events[-1]["response"]
        assert response["reply"] == "流式回复"
        assert response["metrics"]["prefillTokensPerSecond"] is not None
        assert response["metrics"]["generatedTokens"] > 0
        assert any(
            action["actionType"] == "external_model_render"
            and action["status"] == "completed"
            and action["payload"]["stream"] is True
            and action["payload"]["modelCallLogId"]
            for action in response["actions"]
        )
        completed = next(
            action for action in response["actions"] if action["actionType"] == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed["payload"]["modelCallLogId"])
        assert log.status == "completed"
        assert log.response["stream"] is True
        assert log.response["chunks"] == ["流", "式回复"]
        assert log.completion_text == "流式回复"
        assert handler.calls == 1
        assert handler.last_path == "/v1/chat/completions"
        assert handler.last_body["stream"] is True
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_streaming_cot_reasoning_is_logged_not_returned():
    server, handler, thread = _start_fake_openai_stream_server(
        [
            {"reasoning_content": "先思考\\u4e00下。"},
            {"content": "最终回复"},
        ]
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="cot-model",
            )
        )
        events = list(
            kernel.stream_message_events(
                "s1", MessageRequest(mode="sms", text="你好", now=NOW)
            )
        )

        response = events[-1]["response"]
        assert response["reply"] == "最终回复"
        completed = next(
            action for action in response["actions"] if action["actionType"] == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed["payload"]["modelCallLogId"])
        assert log.response["reasoningContent"] == "先思考一下。"
        assert log.response["reasoningChunks"] == ["先思考一下。"]
        assert log.response["chunks"] == ["最终回复"]
        assert log.completion_text == "最终回复"
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_strips_cot_dump_from_visible_reply():
    server, handler, thread = _start_fake_openai_server(
        {
            "choices": [
                {
                    "message": {
                        "content": (
                            "1. **Analyze the Request:** internal notes\n"
                            "2. **Output Generation:**\n"
                            "* \"收到。\""
                        )
                    }
                }
            ],
            "usage": {"total_tokens": 9},
        }
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="cot-content-model",
            )
        )
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="你好", now=NOW)
        )

        assert response.reply == "收到。"
        completed = next(
            action for action in response.actions if action.action_type == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed.payload["modelCallLogId"])
        assert log.completion_text == "收到。"
        assert log.response["visibleSanitized"] is True
        assert log.response["sanitizeReason"] == "reasoning_dump"
        assert "Analyze the Request" in log.response["rawCompletionText"]
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_streaming_buffers_and_strips_cot_dump():
    server, handler, thread = _start_fake_openai_stream_server(
        [
            "1.  **Analyze the Request:** internal notes\n",
            "2.  **Output Generation:**\n",
            "* \"笔尖停下，我看向那枚旧钥匙。\"",
        ]
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="cot-content-model",
            )
        )
        events = list(
            kernel.stream_message_events(
                "s1", MessageRequest(mode="rp", text="旧钥匙落在桌上。", now=NOW)
            )
        )

        deltas = [event["text"] for event in events if event["type"] == "delta"]
        assert deltas == ["笔尖停下，我看向那枚旧钥匙。"]
        response = events[-1]["response"]
        assert response["reply"] == "笔尖停下，我看向那枚旧钥匙。"
        completed = next(
            action for action in response["actions"] if action["actionType"] == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed["payload"]["modelCallLogId"])
        assert log.response["visibleSanitized"] is True
        assert log.response["sanitizeReason"] == "reasoning_dump"
        assert "Analyze the Request" in log.response["rawCompletionText"]
        assert "Analyze the Request" not in log.completion_text
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_streaming_tool_json_falls_back_to_human_reply():
    server, handler, thread = _start_fake_openai_stream_server(
        ['{"actions":[{"actionType":"create_reminder","payload":{"title":"喝水"}}]}']
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="json-leak-model",
            )
        )
        events = list(
            kernel.stream_message_events(
                "s1", MessageRequest(mode="sms", text="三小时后提醒我喝水", now=NOW)
            )
        )

        response = events[-1]["response"]
        assert response["reply"].startswith("已设置提醒：喝水")
        assert "actions" not in response["reply"]
        completed = next(
            action for action in response["actions"] if action["actionType"] == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed["payload"]["modelCallLogId"])
        assert log.response["visibleSanitized"] is True
        assert log.response["sanitizeReason"] == "tool_json"
        assert "actions" in log.response["rawCompletionText"]
        assert log.completion_text.startswith("已设置提醒：喝水")
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_streaming_decodes_literal_unicode_escapes():
    server, handler, thread = _start_fake_openai_stream_server(["\\u4f60\\u597d"])
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="escaped-model",
            )
        )
        events = list(
            kernel.stream_message_events(
                "s1", MessageRequest(mode="sms", text="你好", now=NOW)
            )
        )

        response = events[-1]["response"]
        assert response["reply"] == "你好"
        completed = next(
            action for action in response["actions"] if action["actionType"] == "external_model_render"
        )
        log = kernel.storage.get_model_call_log(completed["payload"]["modelCallLogId"])
        assert log.response["chunks"] == ["你好"]
        assert log.completion_text == "你好"
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_failure_falls_back_to_deterministic_renderer():
    server, handler, thread = _start_fake_openai_server(
        {"error": {"message": "bad upstream"}}, status=500
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="fake-model",
            )
        )
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="你好", now=NOW)
        )
        assert response.reply == "收到。"
        failed = next(
            action for action in response.actions if action.action_type == "external_model_render"
        )
        assert failed.status == "failed"
        assert failed.payload["fallback"] is True
        assert handler.calls == 1
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


def test_external_model_feature_flag_disables_network_call():
    server, handler, thread = _start_fake_openai_server(
        {"choices": [{"message": {"content": "不应调用"}}]}
    )
    kernel = Kernel(":memory:")
    try:
        kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch(
                enabled=True,
                baseUrl=f"http://127.0.0.1:{server.server_port}/v1",
                apiKey="test-key",
                model="fake-model",
            )
        )
        kernel.storage.set_features({FeatureName.external_model: False})
        response = kernel.handle_message(
            "s1", MessageRequest(mode="sms", text="你好", now=NOW)
        )
        assert response.reply == "收到。"
        disabled = next(
            action for action in response.actions if action.action_type == "external_model_render"
        )
        assert disabled.status == "feature_disabled"
        assert handler.calls == 0
    finally:
        kernel.close()
        _stop_fake_openai_server(server, thread)


class _FakeOpenAIHandler(BaseHTTPRequestHandler):
    response_body: dict = {}
    stream_chunks: list[str | dict] | None = None
    status: int = 200
    calls: int = 0
    last_path: str = ""
    last_body: dict = {}

    def do_POST(self):
        type(self).calls += 1
        type(self).last_path = self.path
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        type(self).last_body = json.loads(raw)
        if type(self).stream_chunks is not None and type(self).last_body.get("stream"):
            self.send_response(type(self).status)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for chunk in type(self).stream_chunks or []:
                delta = chunk if isinstance(chunk, dict) else {"content": chunk}
                payload = {
                    "model": type(self).last_body.get("model", "fake-model"),
                    "choices": [{"delta": delta}],
                }
                self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.005)
            usage = {"usage": {"completion_tokens": len(type(self).stream_chunks or [])}}
            self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        body = json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(type(self).status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def _start_fake_openai_server(response_body: dict, status: int = 200):
    handler = type(
        "ConfiguredFakeOpenAIHandler",
        (_FakeOpenAIHandler,),
        {
            "response_body": response_body,
            "stream_chunks": None,
            "status": status,
            "calls": 0,
            "last_body": {},
            "last_path": "",
        },
    )
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, handler, thread


def _start_fake_openai_stream_server(chunks: list[str | dict], status: int = 200):
    handler = type(
        "ConfiguredFakeOpenAIStreamHandler",
        (_FakeOpenAIHandler,),
        {
            "response_body": {},
            "stream_chunks": chunks,
            "status": status,
            "calls": 0,
            "last_body": {},
            "last_path": "",
        },
    )
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, handler, thread


def _stop_fake_openai_server(server: HTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
