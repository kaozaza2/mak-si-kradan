"""ผู้เล่นหนึ่งคนที่กำลังต่ออยู่ และช่องทางส่งข้อความถึงเขา

ชั้นนี้ไม่รู้จัก WebSocket — มันรู้แค่ว่ามี "การเชื่อมต่อ" ที่ส่งข้อความออกไปได้
ทำให้เทสต์ขับ hub ได้โดยไม่ต้องยกเซิร์ฟเวอร์ขึ้นมาจริง
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from makthai.auth import Kind


class Connection(Protocol):
    """หนึ่งการเชื่อมต่อของผู้เล่นหนึ่งคน (เปิดหลายแท็บได้)"""

    id: str
    session_id: str | None

    def send(self, message: dict[str, Any]) -> None:
        """ส่งข้อความออกไป — ต้องไม่บล็อก"""
        ...

    def close(self) -> None: ...


@dataclass(slots=True)
class Session:
    """ตัวตนของผู้เล่นในหน่วยความจำ อยู่ได้แม้การเชื่อมต่อจะหลุดชั่วคราว"""

    id: str
    name: str
    kind: Kind
    connections: set[Connection] = field(default_factory=set)
    room_id: str | None = None
    match_id: str | None = None
    #: เกมที่กำลังรอจับคู่อยู่ — None คือไม่ได้อยู่ในคิว
    queued_game: str | None = None
    #: ระดับบอท ถ้าที่นั่งนี้เป็นโปรแกรม
    bot_level: str | None = None
    #: โหนดที่ถือห้องหรือแมตช์ของคนนี้อยู่ ถ้าไม่ใช่เครื่องนี้
    #: มีค่าเมื่อไหร่แปลว่าคำสั่งของคนนี้ต้องส่งต่อไปที่นั่น ไม่ใช่ตัดสินใจเอง
    home: str | None = None
    last_seen: float = field(default_factory=time.monotonic)

    @property
    def is_bot(self) -> bool:
        return self.bot_level is not None

    @property
    def online(self) -> bool:
        # บอทไม่มีการเชื่อมต่อ แต่ถือว่าอยู่เสมอตราบที่ยังอยู่ในห้องหรือแมตช์
        return self.is_bot or bool(self.connections)

    @property
    def busy(self) -> bool:
        return self.room_id is not None or self.match_id is not None

    def send(self, message: dict[str, Any]) -> None:
        for connection in tuple(self.connections):
            connection.send(message)

    def public(self) -> dict[str, Any]:
        """ข้อมูลที่ผู้เล่นคนอื่นเห็นได้

        ชื่อบอทเป็นกลางทางภาษา ส่วนระดับส่งไปดิบ ๆ ให้ client ประกอบชื่อเอง
        """
        info: dict[str, Any] = {"id": self.id, "name": self.name, "connected": self.online}
        if self.bot_level:
            info["bot"] = self.bot_level
        return info
