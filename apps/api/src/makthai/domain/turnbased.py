"""ฐานของเกมผลัดตา

จัดการสิ่งที่ทุกเกมผลัดตาต้องมีเหมือนกัน — ที่นั่ง ลำดับเทิร์น คะแนน การถอนตัว
เงื่อนไขจบ และประวัติการเดิน เกมใหม่จึงเขียนแค่กติกาของตัวเอง

การจัดลำดับเทิร์นดูเหมือนง่ายแต่มีรายละเอียดที่พลาดกันบ่อย เช่นคนที่ถอนตัวต้องถูกข้าม
และถ้าคนที่ถือเทิร์นอยู่ถอนตัว ต้องส่งเทิร์นต่อทันทีไม่ใช่ค้างไว้
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from makthai.domain.errors import ActionResult, CommonError
from makthai.domain.types import EndReason, GameResult, PlayerIndex, winners_by_score


class TurnBasedEngine(ABC):
    """หนึ่งแมตช์ของเกมผลัดตาหนึ่งเกม"""

    def __init__(self, player_count: int) -> None:
        self.player_count = player_count
        self.scores: list[int] = [0] * player_count
        self.retired: list[PlayerIndex] = []
        self.current: PlayerIndex = 0
        self.turn: int = 1
        self.status: str = "active"
        self.result: GameResult | None = None

    # ── สถานะ ───────────────────────────────────────────────────────────────

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    def active_players(self) -> list[PlayerIndex]:
        return [i for i in range(self.player_count) if i not in self.retired]

    def next_player(self, current: PlayerIndex) -> PlayerIndex:
        for step in range(1, self.player_count + 1):
            candidate = (current + step) % self.player_count
            if candidate not in self.retired:
                return candidate
        return current

    # ── สิ่งที่แต่ละเกมต้องเขียนเอง ─────────────────────────────────────────

    @abstractmethod
    def apply(self, player: PlayerIndex, action: str, payload: dict[str, Any]) -> ActionResult:
        """ลงมือเล่นหนึ่งครั้ง — เกมเป็นคนตัดสินว่าถูกกติกาไหม"""

    @abstractmethod
    def view(self) -> dict[str, Any]:
        """สถานะที่ส่งให้ client วาด — รูปร่างเป็นของแต่ละเกม"""

    @abstractmethod
    def auto_play_turn(self) -> ActionResult:
        """เล่นแทนผู้เล่นหนึ่งเทิร์น ใช้ตอนหมดเวลาหรือไม่มีใครคุมที่นั่ง"""

    @abstractmethod
    def stats(self) -> dict[str, Any]:
        """สรุปผลตอนจบเกม"""

    # ── สิ่งที่ใช้ร่วมกัน ───────────────────────────────────────────────────

    def advance_turn(self, score_delta: int = 0) -> None:
        """จบเทิร์นปัจจุบัน บวกคะแนน แล้วส่งต่อให้คนถัดไป"""
        self.scores[self.current] += score_delta
        self.current = self.next_player(self.current)
        self.turn += 1

    def retire(self, player: PlayerIndex) -> ActionResult:
        """ผู้เล่นถอนตัว — ที่เหลือเล่นกันต่อ เกมจบเมื่อเหลือคนเดียว"""
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        if not (0 <= player < self.player_count):
            return ActionResult.fail(CommonError.UNKNOWN_PLAYER)
        if player in self.retired:
            return ActionResult.fail(CommonError.ALREADY_RETIRED)

        self.retired.append(player)
        if len(self.active_players()) < 2:
            self.end(EndReason.RESIGN)
            return ActionResult.success()

        if self.current == player:
            self.on_current_player_retired()
            self.current = self.next_player(player)
            self.turn += 1
        return ActionResult.success()

    def on_current_player_retired(self) -> None:  # noqa: B027  (hook ที่เกมจะ override หรือไม่ก็ได้)
        """เผื่อเกมมีสถานะกลางเทิร์นที่ต้องล้างทิ้ง"""

    def end(self, reason: EndReason) -> ActionResult:
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        self.on_ending()
        self.status = "ended"
        self.result = GameResult(
            reason=reason,
            scores=tuple(self.scores),
            winners=winners_by_score(self.scores, self.retired),
        )
        return ActionResult.success()

    def on_ending(self) -> None:  # noqa: B027  (hook ที่เกมจะ override หรือไม่ก็ได้)
        """เผื่อเกมต้องเก็บกวาดก่อนปิดแมตช์"""
