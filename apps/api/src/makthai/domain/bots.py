"""สัญญาของบอท

บอทวางแผนทั้งเทิร์นทีเดียวแล้วคืนลำดับการกระทำ แพลตฟอร์มจะเดินทีละก้าวให้ผู้เล่นเห็น
เช่นการกินต่อเนื่องที่ควรเห็นหมากค่อย ๆ ไล่กินไปทีละตัว ไม่ใช่กระโดดถึงปลายทางเลย

ผลพลอยได้คือแพลตฟอร์มไม่ต้องรู้ว่าเกมไหนมีการกระทำอะไรบ้าง
"""

from __future__ import annotations

from typing import Any, Protocol

from makthai.domain.turnbased import TurnBasedEngine

#: หนึ่งการกระทำ — ชื่อคำสั่งกับข้อมูลประกอบ
BotAction = tuple[str, dict[str, Any]]


class BotPlayer(Protocol):
    """ผู้เล่นที่เป็นโปรแกรม"""

    level: str

    def plan_turn(self, engine: TurnBasedEngine) -> list[BotAction]:
        """คืนลำดับการกระทำสำหรับหนึ่งเทิร์น — ว่างเปล่าคือไม่มีอะไรให้เล่น"""
        ...
