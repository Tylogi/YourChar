from __future__ import annotations

from ..models import CalendarEvent, FeatureName, MessageRequest, Reminder, Task
from ..storage import Storage
from .tools import ExecutionResult


class Renderer:
    def render(
        self,
        request: MessageRequest,
        execution: ExecutionResult,
        *,
        storage: Storage | None = None,
        session_id: str | None = None,
    ) -> str:
        if request.mode == "rp":
            return self._render_rp(request, execution)
        return self._render_sms(execution, storage=storage, session_id=session_id)

    def _render_sms(
        self,
        execution: ExecutionResult,
        *,
        storage: Storage | None = None,
        session_id: str | None = None,
    ) -> str:
        continuity = _shared_continuity_hint(storage, session_id)
        practical_continuity = _shared_continuity_hint(
            storage, session_id, include_detail=False
        )
        pending_confirmation = _pending_confirmation(execution)
        if pending_confirmation:
            confirmation = pending_confirmation
            return f"需要确认：{confirmation.reason} 确认 ID：{confirmation.id}"

        disabled = [action for action in execution.actions if action.status == "feature_disabled"]
        if disabled:
            features = _feature_labels(disabled)
            return f"{features}暂时关闭，未执行相关操作。"

        events: list[CalendarEvent] = execution.artifacts.get("calendarEvents", [])
        tasks: list[Task] = execution.artifacts.get("tasks", [])
        reminders: list[Reminder] = execution.artifacts.get("reminders", [])

        created_event = _first_action(execution, "create_calendar")
        if created_event and events:
            event = events[0]
            return _with_continuity(
                f"已安排：{event.title}，时间 {event.start.strftime('%Y-%m-%d %H:%M')}。",
                practical_continuity,
            )

        listed_calendar = _first_action(execution, "list_calendar")
        if listed_calendar:
            if not events:
                return _with_continuity("这段时间没有日程。", practical_continuity)
            lines = [f"{event.start.strftime('%m-%d %H:%M')} {event.title}" for event in events[:5]]
            return _with_continuity("日程：\n" + "\n".join(lines), practical_continuity)

        deleted_event = _first_action(execution, "delete_calendar")
        if deleted_event:
            if deleted_event.status == "completed":
                return f"已删除日程：{deleted_event.payload.get('title', '日程')}。"
            return f"没删到日程：{deleted_event.payload.get('reason', '未找到匹配项')}。"

        rescheduled_event = _first_action(execution, "reschedule_calendar")
        if rescheduled_event and rescheduled_event.status == "completed":
            return (
                f"已改期：{rescheduled_event.payload.get('title', '日程')}，"
                f"新时间 {_format_payload_time(rescheduled_event.payload.get('start'))}。"
            )

        created_reminder = _first_action(execution, "create_reminder")
        if created_reminder and reminders:
            reminder = reminders[0]
            return _with_continuity(
                f"已设置提醒：{reminder.title}，时间 {reminder.remind_at.strftime('%Y-%m-%d %H:%M')}。",
                practical_continuity,
            )

        deleted_reminder = _first_action(execution, "delete_reminder")
        if deleted_reminder:
            if deleted_reminder.status == "completed":
                return f"已取消提醒：{deleted_reminder.payload.get('title', '提醒')}。"
            return f"没取消提醒：{deleted_reminder.payload.get('reason', '未找到匹配项')}。"

        updated_reminder = _first_action(execution, "update_reminder")
        if updated_reminder:
            if updated_reminder.status == "completed":
                return (
                    f"已更新提醒：{updated_reminder.payload.get('title', '提醒')}，"
                    f"新时间 {_format_payload_time(updated_reminder.payload.get('remindAt'))}。"
                )
            return f"没更新提醒：{updated_reminder.payload.get('reason', '未找到匹配项')}。"

        created_task = _first_action(execution, "create_task")
        if created_task and tasks:
            task = tasks[0]
            due = f"，截止 {task.due_at.strftime('%Y-%m-%d %H:%M')}" if task.due_at else ""
            return _with_continuity(f"已添加任务：{task.title}{due}。", practical_continuity)

        listed_tasks = _first_action(execution, "list_tasks")
        if listed_tasks:
            if not tasks:
                return _with_continuity("当前没有任务。", practical_continuity)
            lines = [f"{task.status} {task.title}" for task in tasks[:8]]
            return _with_continuity("任务：\n" + "\n".join(lines), practical_continuity)

        deleted_task = _first_action(execution, "delete_task")
        if deleted_task:
            if deleted_task.status == "completed":
                return f"已删除任务：{deleted_task.payload.get('title', '任务')}。"
            return f"没删到任务：{deleted_task.payload.get('reason', '未找到匹配项')}。"

        memory_action = _first_action(execution, "write_secretary_memory")
        if memory_action:
            return "我记住了。"

        bulk_delete = _first_action(execution, "bulk_delete_calendar")
        if bulk_delete:
            return f"已删除 {bulk_delete.payload.get('deleted', 0)} 条日程。"

        return _with_continuity("收到。", continuity)

    def _render_rp(self, request: MessageRequest, execution: ExecutionResult) -> str:
        pending_confirmation = _pending_confirmation(execution)
        if pending_confirmation:
            confirmation = pending_confirmation
            return (
                f"她停下动作，把这件事从叙事里单独拎出来：{confirmation.reason}"
                f"如果要继续，请确认 {confirmation.id}。在此之前，现实日程不会被改动。"
            )

        disabled = [action for action in execution.actions if action.status == "feature_disabled"]
        if disabled:
            features = _feature_labels(disabled)
            return (
                f"这段叙事可以继续，但{features}暂时不可用。"
                "她不会把场景内容写进对应的现实工具。"
            )

        events: list[CalendarEvent] = execution.artifacts.get("calendarEvents", [])
        tasks: list[Task] = execution.artifacts.get("tasks", [])
        reminders: list[Reminder] = execution.artifacts.get("reminders", [])

        created_event = _first_action(execution, "create_calendar")
        if created_event and events:
            event = events[0]
            return (
                f"她看了眼时间，把这件现实安排记了下来：{event.title}，"
                f"{event.start.strftime('%Y-%m-%d %H:%M')}。"
                "那条记录留在现实日程里，场景里的脚步也随之放慢了一点。"
            )

        listed_calendar = _first_action(execution, "list_calendar")
        if listed_calendar:
            if not events:
                return "她把当前日程快速扫过一遍，抬头看向你：这段时间没有现实日程。"
            lines = [f"{event.start.strftime('%m-%d %H:%M')} {event.title}" for event in events[:5]]
            return "她把现实日程摊在桌边：\n" + "\n".join(lines)

        deleted_event = _first_action(execution, "delete_calendar")
        if deleted_event:
            if deleted_event.status == "completed":
                return f"她把这条现实日程划掉：{deleted_event.payload.get('title', '日程')}。"
            return f"她查了一遍现实日程，摇了摇头：{deleted_event.payload.get('reason', '未找到匹配项')}。"

        rescheduled_event = _first_action(execution, "reschedule_calendar")
        if rescheduled_event and rescheduled_event.status == "completed":
            return (
                f"她把现实日程改到新的位置：{rescheduled_event.payload.get('title', '日程')}，"
                f"{_format_payload_time(rescheduled_event.payload.get('start'))}。"
            )

        created_reminder = _first_action(execution, "create_reminder")
        if created_reminder and reminders:
            reminder = reminders[0]
            return (
                f"她把提醒写进现实清单：{reminder.title}，"
                f"{reminder.remind_at.strftime('%Y-%m-%d %H:%M')}。"
                "到点时，她会把这件事重新递到你面前。"
            )

        deleted_reminder = _first_action(execution, "delete_reminder")
        if deleted_reminder:
            if deleted_reminder.status == "completed":
                return f"她把这条现实提醒撤掉：{deleted_reminder.payload.get('title', '提醒')}。"
            return f"她翻过提醒清单，低声说：{deleted_reminder.payload.get('reason', '未找到匹配项')}。"

        updated_reminder = _first_action(execution, "update_reminder")
        if updated_reminder:
            if updated_reminder.status == "completed":
                return (
                    f"她把提醒时间改好：{updated_reminder.payload.get('title', '提醒')}，"
                    f"{_format_payload_time(updated_reminder.payload.get('remindAt'))}。"
                )
            return f"她没能更新提醒：{updated_reminder.payload.get('reason', '未找到匹配项')}。"

        created_task = _first_action(execution, "create_task")
        if created_task and tasks:
            task = tasks[0]
            due = f"，截止 {task.due_at.strftime('%Y-%m-%d %H:%M')}" if task.due_at else ""
            return f"她在清单上添了一行现实任务：{task.title}{due}。"

        listed_tasks = _first_action(execution, "list_tasks")
        if listed_tasks:
            if not tasks:
                return "她翻过任务清单，声音很轻：现在没有打开的任务。"
            lines = [f"{task.status} {task.title}" for task in tasks[:8]]
            return "她把任务清单推到你面前：\n" + "\n".join(lines)

        deleted_task = _first_action(execution, "delete_task")
        if deleted_task:
            if deleted_task.status == "completed":
                return f"她从现实任务清单里删掉：{deleted_task.payload.get('title', '任务')}。"
            return f"她没有删掉任务：{deleted_task.payload.get('reason', '未找到匹配项')}。"

        memory_action = _first_action(execution, "write_rp_memory")
        if memory_action:
            return (
                "灯影压低，场景里的气息被慢慢收束成一条清晰的线。"
                "她没有急着追问，只把刚才的细节压在指腹下，像按住一页尚未归档的证词。"
                "片刻后，她抬眼看向你，声音放得很低：“继续说。这里每一处细节，都要留下证据。”"
            )

        if events:
            event = events[0]
            return (
                f"她确认了现实日程：{event.title}，{event.start.strftime('%Y-%m-%d %H:%M')}。"
                "这件事属于现实时间线，不会被误写成剧情事实。"
            )

        return (
            "场景保持安静，角色没有急着推动事件。"
            "她把手边的卷宗合上一半，留出足够的沉默给你继续说明。"
            "雨声落在窗沿上，像一串被压低的编号，等待下一条线索被放到桌面。"
        )


def _first_action(execution: ExecutionResult, action_type: str):
    return next((action for action in execution.actions if action.action_type == action_type), None)


def _pending_confirmation(execution: ExecutionResult):
    return next(
        (confirmation for confirmation in execution.confirmations if confirmation.status == "pending"),
        None,
    )


def _format_payload_time(value) -> str:
    if not value:
        return "未知时间"
    try:
        from datetime import datetime

        return datetime.fromisoformat(str(value)).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(value)


def _shared_continuity_hint(
    storage: Storage | None, session_id: str | None, *, include_detail: bool = True
) -> str:
    if storage is None or not session_id or not storage.is_enabled(FeatureName.shared_timeline):
        return ""
    episodes = storage.list_shared_episodes(session_id=session_id, limit=1)
    if not episodes:
        return ""
    if not include_detail:
        return "我还记得刚才那段。"
    summary = episodes[0].summary
    marker = "共同经历了："
    if marker in summary:
        summary = summary.split(marker, 1)[1]
    summary = " ".join(summary.replace("\n", " ").split()).strip("。")
    if not summary:
        return ""
    if len(summary) > 28:
        summary = summary[:27].rstrip() + "…"
    return f"我还记得刚才那段：{summary}。"


def _with_continuity(reply: str, continuity: str) -> str:
    if not continuity:
        return reply
    separator = "\n" if "\n" in reply and not reply.endswith("\n") else ""
    return f"{reply}{separator}{continuity}"


def _feature_labels(actions) -> str:
    labels = []
    for action in actions:
        feature = getattr(action, "feature", None)
        labels.append(_feature_label(str(feature.value if hasattr(feature, "value") else feature)))
    compact = [label for index, label in enumerate(labels) if label and label not in labels[:index]]
    return "、".join(compact) or "相关功能"


def _feature_label(feature: str) -> str:
    return {
        "calendar": "日程功能",
        "tasks": "任务功能",
        "reminders": "提醒功能",
        "characters": "角色功能",
        "external_model": "外部模型",
        "rp_memory": "生活记忆",
        "secretary_memory": "消息记忆",
        "context_trace": "上下文追踪",
        "confirmation_safety": "安全确认",
        "ics": "日历导入导出",
        "event_stream": "事件流",
        "metrics": "指标统计",
        "deterministic_eval": "评估接口",
        "fts_search": "记忆检索",
        "shared_timeline": "共同时间线",
        "companion_persona": "同行者设定",
        "reality_projection": "现实投影",
        "debug_time": "调试时间",
    }.get(feature, "相关功能")
