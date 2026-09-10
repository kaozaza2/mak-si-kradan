"""หนึ่งแมตช์ที่กำลังเล่นอยู่

ห่อ engine ของเกมไว้พร้อมกับสิ่งที่ engine ไม่ควรรู้จัก — ผู้เล่นคือใคร นาฬิกาเทิร์น
การโหวตจบเกม การขอเล่นใหม่ และที่นั่งที่ AI คุมแทนเจ้าของที่หายไป

แมตช์ไม่รู้จักกติกาของเกมเลย มันคุยกับ engine ผ่านสัญญาเดียวกันหมด
เกมใหม่จึงใช้ชั้นนี้ได้ทันทีโดยไม่ต้องแก้อะไร
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from makthai.domain.bots import BotAction
from makthai.domain.registry import GameDefinition
from makthai.domain.turnbased import TurnBasedEngine
from makthai.realtime.scheduler import TimerHandle


@dataclass(slots=True)
class Match:
    id: str
    game: GameDefinition
    engine: TurnBasedEngine
    #: id ของ session เรียงตามที่นั่ง
    player_ids: list[str]
    turn_seconds: int
    #: นับคะแนนอันดับหรือไม่ — ห้องที่ตั้งค่าเองและเกมที่มีบอทไม่นับ
    ranked: bool = True
    mode: str = ""

    #: ที่นั่งที่เสนอให้จบเกม
    end_offer_by: int | None = None
    #: ที่นั่งที่โหวตให้จบแล้ว
    end_votes: set[int] = field(default_factory=set)
    rematch_requests: set[str] = field(default_factory=set)

    #: ที่นั่งที่ให้ AI คุมแทนชั่วคราว เพราะเจ้าของหลุด ออกไป หรือปล่อยหมดเวลา
    #: ต่างจากการยอมแพ้ตรงที่เจ้าของยังเป็นเจ้าของคะแนน และกลับมาคุมเองได้ทุกเมื่อ
    autopilot: dict[int, str] = field(default_factory=dict)

    deadline: float | None = None
    _clock: TimerHandle | None = None
    _bot_timer: TimerHandle | None = None
    #: แผนของบอทที่กำลังเดินทีละก้าวอยู่
    bot_plan: list[BotAction] = field(default_factory=list)

    # ── ที่นั่ง ─────────────────────────────────────────────────────────────

    def seat_of(self, session_id: str) -> int:
        try:
            return self.player_ids.index(session_id)
        except ValueError:
            return -1

    def others_of(self, session_id: str) -> list[str]:
        return [pid for pid in self.player_ids if pid != session_id]

    # ── นาฬิกาเทิร์น ────────────────────────────────────────────────────────

    def arm_clock(self, scheduler: Any, on_timeout: Any) -> None:
        self.clear_clock()
        if self.turn_seconds <= 0 or not self.engine.is_active:
            self.deadline = None
            return
        self.deadline = time.time() + self.turn_seconds
        self._clock = scheduler.call_later(self.turn_seconds, on_timeout)

    def clear_clock(self) -> None:
        if self._clock is not None:
            self._clock.cancel()
        self._clock = None
        self.deadline = None

    # ── บอท ─────────────────────────────────────────────────────────────────

    def schedule_bot(self, scheduler: Any, delay: float, step: Any) -> None:
        if self._bot_timer is not None:
            return
        self._bot_timer = scheduler.call_later(delay, step)

    def bot_timer_fired(self) -> None:
        self._bot_timer = None

    def clear_bot(self) -> None:
        if self._bot_timer is not None:
            self._bot_timer.cancel()
        self._bot_timer = None
        self.bot_plan = []

    # ── โหวตจบเกม ───────────────────────────────────────────────────────────

    def clear_end_offer(self) -> None:
        """ต้องล้างทั้งผู้เสนอและโหวตพร้อมกันเสมอ ไม่งั้นโหวตเก่าจะค้างและนับผิด"""
        self.end_offer_by = None
        self.end_votes.clear()

    # ── สถานะที่ส่งให้ client ───────────────────────────────────────────────

    def state_view(self, players: list[dict[str, Any]], votes_needed: int) -> dict[str, Any]:
        return {
            "matchId": self.id,
            "gameId": self.game.id,
            "mode": self.mode,
            "ranked": self.ranked,
            "players": players,
            "turnSeconds": self.turn_seconds,
            "deadline": self.deadline,
            # เวลาของเซิร์ฟเวอร์ ให้ client ชดเชยนาฬิกาที่ไม่ตรงกันได้
            "now": time.time(),
            "endOfferBy": self.end_offer_by,
            "endVotes": sorted(self.end_votes),
            "endVotesNeeded": votes_needed,
            "autopilot": sorted(self.autopilot),
            # สถานะของเกมเอง รูปร่างเป็นของแต่ละเกม
            "view": self.engine.view(),
        }
