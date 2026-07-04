from datetime import datetime
from zoneinfo import ZoneInfo

from rp_agent_kernel.timeparse import parse_time_expression


def test_chinese_time_expressions_are_deterministic():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai"))

    tonight = parse_time_expression("今晚八点提醒我", now)
    assert tonight.when.isoformat() == "2026-07-02T20:00:00+08:00"

    later = parse_time_expression("三小时后提醒我喝水", now)
    assert later.when.isoformat() == "2026-07-02T15:00:00+08:00"

    next_friday = parse_time_expression("下周五下午开会", now)
    assert next_friday.when.isoformat() == "2026-07-10T15:00:00+08:00"

    weekly = parse_time_expression("每周一早上同步", now)
    assert weekly.when.isoformat() == "2026-07-06T09:00:00+08:00"
    assert weekly.recurrence == "weekly:MO"
