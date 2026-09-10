"""โดเมนกลางของแพลตฟอร์ม — ไม่รู้จัก HTTP, WebSocket, ฐานข้อมูล หรือบัญชีผู้ใช้

ชั้นนี้มีแต่สิ่งที่ทุกเกมใช้ร่วมกัน กติกาของเกมแต่ละเกมอยู่ใน `makthai.games`
"""

from makthai.domain.errors import ActionResult, CommonError, GameError
from makthai.domain.registry import GameDefinition, GameRegistry, registry
from makthai.domain.turnbased import TurnBasedEngine
from makthai.domain.types import (
    EndReason,
    GameResult,
    PlayerIndex,
    winners_by_score,
)

__all__ = [
    "ActionResult",
    "CommonError",
    "EndReason",
    "GameDefinition",
    "GameError",
    "GameRegistry",
    "GameResult",
    "PlayerIndex",
    "TurnBasedEngine",
    "registry",
    "winners_by_score",
]
