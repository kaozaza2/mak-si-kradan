"""ทะเบียนเกมของแพลตฟอร์ม

การเพิ่มเกมใหม่ = สร้างแพ็กเกจใน `makthai/games/` แล้วเรียก `register()`
ส่วน lobby, การจับคู่, ห้อง, เพื่อน, การกระจายหลาย node ใช้ของเดิมได้ทั้งหมด
โดยไม่ต้องแก้อะไรเลย

ชื่อเกมไม่ได้อยู่ที่นี่ — อยู่ในแคตตาล็อกข้อความเป็นรหัส `game_<id>` ตามหลักเดียว
กับข้อความอื่นทั้งระบบ ที่เซิร์ฟเวอร์ไม่ส่งข้อความภาษาคนออกไป
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from makthai.domain.bots import BotPlayer
from makthai.domain.turnbased import TurnBasedEngine


@dataclass(frozen=True, slots=True)
class GameDefinition:
    """ทุกอย่างที่แพลตฟอร์มต้องรู้เกี่ยวกับเกมหนึ่งเกม"""

    id: str
    #: อีโมจิสำหรับการ์ดเกมและแถบข้าง
    icon: str
    min_players: int
    max_players: int
    default_turn_seconds: int
    #: ชื่อชุดกติกาที่เกมนี้รองรับ เรียงจากที่แนะนำก่อน — ความหมายเป็นของเกมเอง
    modes: tuple[str, ...]
    #: สร้างแมตช์ใหม่ ผู้เรียกส่งจำนวนผู้เล่นกับชื่อโหมดมาให้
    create: Callable[..., TurnBasedEngine]
    #: ระดับบอทที่เกมนี้มี — ว่างเปล่าคือยังไม่มีบอท
    bot_levels: tuple[str, ...] = ()
    #: สร้างบอทหนึ่งตัวตามระดับที่ขอ
    create_bot: Callable[[str], BotPlayer] | None = None
    #: ค่าตั้งต้นอื่น ๆ ที่ client ใช้แสดงฟอร์มสร้างห้อง
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def has_bots(self) -> bool:
        return bool(self.bot_levels)


class GameRegistry:
    def __init__(self) -> None:
        self._games: dict[str, GameDefinition] = {}

    def register(self, definition: GameDefinition) -> GameDefinition:
        if definition.id in self._games:
            raise ValueError(f"เกม '{definition.id}' ถูกลงทะเบียนไปแล้ว")
        if definition.min_players < 2:
            raise ValueError("เกมผลัดตาต้องมีอย่างน้อย 2 ที่นั่ง")
        if definition.max_players < definition.min_players:
            raise ValueError("จำนวนผู้เล่นสูงสุดต้องไม่น้อยกว่าค่าต่ำสุด")
        if not definition.modes:
            raise ValueError("ต้องมีชุดกติกาอย่างน้อยหนึ่งชุด")
        if definition.bot_levels and definition.create_bot is None:
            raise ValueError("ประกาศระดับบอทไว้แล้วต้องมีวิธีสร้างบอทด้วย")
        self._games[definition.id] = definition
        return definition

    def get(self, game_id: str) -> GameDefinition | None:
        return self._games.get(game_id)

    def require(self, game_id: str) -> GameDefinition:
        definition = self._games.get(game_id)
        if definition is None:
            raise KeyError(f"ไม่รู้จักเกม '{game_id}'")
        return definition

    def resolve(self, game_id: str | None) -> GameDefinition:
        """คืนเกมที่ขอ หรือเกมแรกในทะเบียนถ้าไม่ได้ระบุ/ไม่รู้จัก"""
        if game_id and game_id in self._games:
            return self._games[game_id]
        return self.default()

    def default(self) -> GameDefinition:
        if not self._games:
            raise RuntimeError("ยังไม่มีเกมในทะเบียน")
        return next(iter(self._games.values()))

    def all(self) -> list[GameDefinition]:
        return list(self._games.values())

    @property
    def ids(self) -> list[str]:
        return list(self._games)

    def __contains__(self, game_id: object) -> bool:
        return game_id in self._games

    def __len__(self) -> int:
        return len(self._games)


#: ทะเบียนกลางของแพลตฟอร์ม
registry = GameRegistry()
