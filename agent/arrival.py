"""Expected arrival for the order read-back (#59, VO-6).

Physical delivery is a non-goal this weekend (SPEC §3.2), so this is demo data: next-day
delivery by default, worded in the caller's own timezone so "tomorrow" means their tomorrow.

Configuration (all optional):
  ORDER_ARRIVAL_PHRASE  fixed phrase that overrides everything, e.g. "Monday"
  ORDER_ARRIVAL_DAYS    days until arrival (default 1, clamped to 1-14)
  ORDER_CUTOFF_HOUR     local hour (0-23) after which arrival moves one day later
"""

import os
from datetime import datetime, timedelta


def _int_env(name: str, default: int | None) -> int | None:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def expected_arrival(now: datetime) -> str:
    """Speakable arrival, e.g. "tomorrow, Sunday, October 25". `now` is in the caller's zone."""
    override = (os.getenv("ORDER_ARRIVAL_PHRASE") or "").strip()
    if override:
        return override
    days = min(max(_int_env("ORDER_ARRIVAL_DAYS", 1) or 1, 1), 14)
    cutoff = _int_env("ORDER_CUTOFF_HOUR", None)
    if cutoff is not None and 0 <= cutoff <= 23 and now.hour >= cutoff:
        days += 1
    day = now + timedelta(days=days)
    date = f"{day:%A}, {day:%B} {day.day}"
    if days == 1:
        return f"tomorrow, {date}"
    if days == 2:
        return f"the day after tomorrow, {date}"
    return date
