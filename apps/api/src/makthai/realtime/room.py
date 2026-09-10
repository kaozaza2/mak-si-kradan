"""ห้องรอเล่น

ห้องผูกกับเกมตั้งแต่สร้าง เพราะรายการห้องและการจับคู่ต้องแยกตามเกม
ไม่งั้นคนที่อยากเล่นเกมหนึ่งจะเห็นห้องของอีกเกมปนมา
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

RoomStatus = Literal["waiting", "ready", "playing"]
Visibility = Literal["public", "private"]


@dataclass(slots=True)
class Room:
    id: str
    code: str
    game_id: str
    host_id: str
    #: ผู้เล่นในห้องตามลำดับที่เข้ามา เจ้าของห้องอยู่ลำดับแรกเสมอ
    members: list[str]
    capacity: int
    visibility: Visibility
    mode: str
    turn_seconds: int
    #: ตั้งค่าเองจนไม่นับคะแนนอันดับ
    custom: bool
    status: RoomStatus = "waiting"
    created_at: float = field(default_factory=time.time)

    @property
    def full(self) -> bool:
        return len(self.members) >= self.capacity

    @property
    def can_start(self) -> bool:
        return len(self.members) >= 2 and self.status != "playing"

    def refresh_status(self) -> None:
        if self.status == "playing":
            return
        self.status = "ready" if len(self.members) >= 2 else "waiting"

    def view(self, players: list[dict[str, Any]], invite_url: str) -> dict[str, Any]:
        return {
            "id": self.id,
            "gameId": self.game_id,
            "code": self.code,
            "hostId": self.host_id,
            "status": self.status,
            "visibility": self.visibility,
            "mode": self.mode,
            "capacity": self.capacity,
            "turnSeconds": self.turn_seconds,
            "custom": self.custom,
            "players": players,
            "inviteUrl": invite_url,
        }

    def summary(self, host_name: str, bots: int) -> dict[str, Any]:
        """ข้อมูลย่อสำหรับหน้ารายการห้อง — ไม่เปิดเผยรหัสห้อง"""
        return {
            "id": self.id,
            "gameId": self.game_id,
            "hostName": host_name,
            "players": len(self.members),
            "bots": bots,
            "capacity": self.capacity,
            "turnSeconds": self.turn_seconds,
            "mode": self.mode,
            "custom": self.custom,
            "createdAt": self.created_at,
        }
