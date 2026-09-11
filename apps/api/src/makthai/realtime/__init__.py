"""การเล่นออนไลน์ — ตัวตน ห้อง การจับคู่ และการเดินเกมแบบเรียลไทม์

ชั้นนี้ไม่รู้จักกติกาของเกมใดเลย ทุกการเล่นถูกส่งต่อไปให้ engine ของเกมตัดสิน
"""

from makthai import PROTOCOL_VERSION
from makthai.realtime.hub import Hub
from makthai.realtime.match import Match
from makthai.realtime.room import Room
from makthai.realtime.scheduler import AsyncioScheduler, ManualScheduler, Scheduler
from makthai.realtime.session import Connection, Session

__all__ = [
    "PROTOCOL_VERSION",
    "AsyncioScheduler",
    "Connection",
    "Hub",
    "ManualScheduler",
    "Match",
    "Room",
    "Scheduler",
    "Session",
]
