from __future__ import annotations

from .models import CalendarEvent, FeatureName, MessageRequest, Reminder, Task
from .storage import Storage
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
        if execution.confirmations:
            confirmation = execution.confirmations[0]
            return f"需要确认：{confirmation.reason} 确认 ID：{confirmation.id}"

        disabled = [action for action in execution.actions if action.status == "feature_disabled"]
        if disabled:
            features = "、".join(str(action.feature) for action in disabled)
            return f"功能已关闭：{features}。未执行相关操作。"

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

        created_reminder = _first_action(execution, "create_reminder")
        if created_reminder and reminders:
            reminder = reminders[0]
            return _with_continuity(
                f"已设置提醒：{reminder.title}，时间 {reminder.remind_at.strftime('%Y-%m-%d %H:%M')}。",
                practical_continuity,
            )

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

        memory_action = _first_action(execution, "write_secretary_memory")
        if memory_action:
            return "我记住了。"

        bulk_delete = _first_action(execution, "bulk_delete_calendar")
        if bulk_delete:
            return f"已删除 {bulk_delete.payload.get('deleted', 0)} 条日程。"

        return _with_continuity("收到。", continuity)

    def _render_rp(self, request: MessageRequest, execution: ExecutionResult) -> str:
        if execution.confirmations:
            confirmation = execution.confirmations[0]
            return (
                f"我停下动作，把这件事从剧情里单独拎出来：{confirmation.reason}"
                f"如果要继续，请确认 {confirmation.id}。在此之前，现实日程不会被改动。"
            )

        disabled = [action for action in execution.actions if action.status == "feature_disabled"]
        if disabled:
            features = "、".join(str(action.feature) for action in disabled)
            return (
                f"这段叙事可以继续，但被关闭的能力不会介入：{features}。"
                "我会只保留当前对话的表演层，不写入对应的内核状态。"
            )

        memory_action = _first_action(execution, "write_rp_memory")
        if memory_action:
            return (
                "灯影压低，场景里的气息被慢慢收束成一条清晰的线。"
                "我没有急着追问，只把刚才的细节压在指腹下，像按住一页尚未归档的证词。"
                "片刻后，我抬眼看向你，声音放得很低：“继续说。这里每一处细节，都要留下证据。”"
            )

        events: list[CalendarEvent] = execution.artifacts.get("calendarEvents", [])
        if events:
            event = events[0]
            return (
                f"我把叙事暂时放在一边，替你处理现实日程：{event.title} 已放到 "
                f"{event.start.strftime('%Y-%m-%d %H:%M')}。回到角色视角时，这条现实安排不会被当作剧情事实。"
            )

        return (
            "场景保持安静，角色没有急着推动事件。"
            "我把手边的卷宗合上一半，留出足够的沉默给你继续说明。"
            "雨声落在窗沿上，像一串被压低的编号，等待下一条线索被放到桌面。"
        )


def _first_action(execution: ExecutionResult, action_type: str):
    return next((action for action in execution.actions if action.action_type == action_type), None)


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
    return f"{reply}{continuity}"
