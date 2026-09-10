"""ผลของการสั่งเล่น และรหัสข้อผิดพลาดที่ใช้ร่วมกันทุกเกม

โดเมนไม่ผลิตข้อความให้มนุษย์อ่าน เพราะมันไม่รู้ว่าใครจะเอาไปแสดงและด้วยภาษาอะไร
มันบอกแค่ว่า "อะไรผิด" พร้อมค่าประกอบ ส่วน "จะพูดว่าอย่างไร" เป็นหน้าที่ของ client

แต่ละเกมนิยามรหัสของตัวเองเพิ่มได้ ขอแค่เป็นสตริง แล้วไปเพิ่มคำแปลในแคตตาล็อกข้อความ
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class CommonError(StrEnum):
    """รหัสที่ทุกเกมใช้เหมือนกัน"""

    GAME_ENDED = "game_ended"
    NOT_YOUR_TURN = "not_your_turn"
    UNKNOWN_PLAYER = "unknown_player"
    ALREADY_RETIRED = "already_retired"
    UNKNOWN_ACTION = "unknown_action"
    NO_LEGAL_ACTION = "no_legal_action"


@dataclass(frozen=True, slots=True)
class GameError:
    code: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ActionResult:
    ok: bool
    error: GameError | None = None

    @staticmethod
    def success() -> ActionResult:
        return ActionResult(ok=True)

    @staticmethod
    def fail(code: str, **params: Any) -> ActionResult:
        return ActionResult(ok=False, error=GameError(code=str(code), params=params))

    def __bool__(self) -> bool:
        return self.ok
