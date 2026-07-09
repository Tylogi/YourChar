from __future__ import annotations

import re

from ..models import Mode


FICTIONAL_MARKERS = (
    "剧情",
    "故事",
    "设定",
    "角色",
    "场景",
    "剧本",
    "虚构",
    "世界观",
    "rp",
    "roleplay",
)


def has_fictional_marker(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in FICTIONAL_MARKERS)


def is_explicit_real_request(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith("/real") or any(
        phrase in stripped
        for phrase in (
            "现实",
            "真实",
            "现实中",
            "真实中",
            "现实日程",
            "真实日程",
            "现实提醒",
            "真实提醒",
            "现实任务",
            "真实任务",
        )
    )


def allows_real_tools(mode: Mode, text: str) -> bool:
    if is_explicit_real_request(text):
        return True
    if has_fictional_marker(text):
        return False
    if mode == "sms":
        return True
    return has_real_tool_intent(text)


def include_authoritative_real_state(mode: Mode, text: str) -> bool:
    if mode == "sms":
        return True
    return allows_real_tools(mode, text)


def has_real_tool_intent(text: str) -> bool:
    return bool(
        re.search(
            r"(提醒|日程|安排|预约|会议|开会|待办|任务|todo|schedule|有什么安排|查看|查询|列出|改期|改到|推迟|延期|删除|清空)",
            text,
            re.I,
        )
    )
