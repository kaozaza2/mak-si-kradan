"""บันทึกผลการแข่งและคิดอันดับ

การเขียนลงฐานข้อมูลต้องไม่มีวันทำให้เกมสะดุด ผู้เรียกจึงยิงงานเข้าคิวแล้วเดินต่อ
ส่วนคิวเป็นสายเดียวเพราะลำดับสำคัญ — แถวของแมตช์ต้องมีก่อนแถวของเทิร์นที่อ้างถึงมัน
ถ้าปล่อยให้ยิงขนานกันจะติด foreign key เป็นครั้งคราว
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from makthai.db.models import Match, MatchAction, MatchPlayer, Player, utcnow
from makthai.db.session import Database
from makthai.rating import RatingInput, compute_changes

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SeatRecord:
    seat: int
    player_id: str
    name: str
    is_bot: bool
    bot_level: str | None


@dataclass(frozen=True, slots=True)
class MatchRecord:
    id: str
    game_id: str
    source: str
    mode: str
    turn_seconds: int
    ranked: bool
    seats: list[SeatRecord]


@dataclass(frozen=True, slots=True)
class MatchOutcome:
    reason: str
    scores: list[int]
    winners: list[int]
    retired: list[int]
    turns: int


class History:
    def __init__(self, database: Database) -> None:
        self.database = database
        self._queue: asyncio.Task[None] | None = None
        self._chain: asyncio.Future[None] | None = None

    # ── คิวเขียน ────────────────────────────────────────────────────────────

    def schedule(self, coro: Any) -> None:
        """ต่อคิวงานเขียนแบบไม่รอผล และกลืนข้อผิดพลาดเองทั้งหมด"""

        async def run() -> None:
            try:
                await coro
            except Exception:
                logger.exception("บันทึกประวัติไม่สำเร็จ")

        previous = self._queue

        async def chained() -> None:
            if previous is not None:
                await asyncio.shield(previous)
            await run()

        self._queue = asyncio.create_task(chained())

    async def flush(self) -> None:
        """รอให้งานเขียนที่ค้างอยู่เสร็จ — ใช้ตอนปิดเซิร์ฟเวอร์และในเทสต์"""
        while self._queue is not None and not self._queue.done():
            await self._queue

    # ── การเขียนจริง ────────────────────────────────────────────────────────

    async def start_match(self, record: MatchRecord) -> None:
        async with self.database.session() as session:
            session.add(
                Match(
                    id=record.id,
                    game_id=record.game_id,
                    source=record.source,
                    mode=record.mode,
                    player_count=len(record.seats),
                    turn_seconds=record.turn_seconds,
                    ranked=record.ranked,
                    players=[
                        MatchPlayer(
                            seat=seat.seat,
                            # บอทไม่มีตัวตนถาวร จึงไม่ผูกกับตารางผู้เล่น
                            player_id=None if seat.is_bot else seat.player_id,
                            name=seat.name,
                            is_bot=seat.is_bot,
                            bot_level=seat.bot_level,
                        )
                        for seat in record.seats
                    ],
                )
            )
            await session.commit()

    async def record_turns(self, match_id: str, turns: list[dict[str, Any]]) -> None:
        if not turns:
            return
        async with self.database.session() as session:
            session.add_all(
                MatchAction(
                    match_id=match_id,
                    turn=int(turn.get("turn", 0)),
                    seat=int(turn.get("player", 0)),
                    detail=json.dumps(turn, ensure_ascii=False),
                )
                for turn in turns
            )
            await session.commit()

    async def finish_match(self, match_id: str, outcome: MatchOutcome) -> None:
        async with self.database.session() as session:
            match = await session.scalar(
                select(Match).where(Match.id == match_id).options(selectinload(Match.players))
            )
            if match is None:
                return

            for seat in match.players:
                seat.score = outcome.scores[seat.seat] if seat.seat < len(outcome.scores) else 0
                seat.retired = seat.seat in outcome.retired
                seat.winner = seat.seat in outcome.winners

            ranked = await self._apply_rating(session, match, outcome)
            match.status = "ended"
            match.reason = outcome.reason
            match.turns = outcome.turns
            match.ranked = ranked
            match.ended_at = utcnow()
            await session.commit()

    async def _apply_rating(self, session: Any, match: Match, outcome: MatchOutcome) -> bool:
        """คิดอันดับให้แมตช์ที่จบแล้ว

        นับเฉพาะแมตช์ที่ทุกที่นั่งเป็นบัญชีที่ยืนยันแล้ว ไม่มีบอทและไม่มีผู้เล่นชั่วคราว
        ไม่งั้นสมัครใหม่รัว ๆ หรือเก็บแต้มจากบอทเพื่อปั่นอันดับได้

        ที่นั่งที่ AI คุมแทนยังนับ เพราะการทิ้งเกมเป็นความรับผิดชอบของเจ้าของที่นั่ง
        """
        if not match.ranked or len(match.players) < 2:
            return False

        players: list[Player] = []
        for seat in match.players:
            if seat.is_bot or seat.player_id is None:
                return False
            player = await session.get(Player, seat.player_id)
            if player is None or player.kind != "user" or player.email_verified_at is None:
                return False
            players.append(player)

        changes = compute_changes(
            [
                RatingInput(
                    rating=player.rating,
                    score=outcome.scores[seat.seat] if seat.seat < len(outcome.scores) else 0,
                    retired=seat.seat in outcome.retired,
                    games_played=player.games_played,
                )
                for seat, player in zip(match.players, players, strict=True)
            ]
        )

        for seat, player, change in zip(match.players, players, changes, strict=True):
            seat.rating_before = change.before
            seat.rating_after = change.after
            player.rating = change.after
            player.games_played += 1
            player.wins += change.outcome == "win"
            player.losses += change.outcome == "loss"
            player.draws += change.outcome == "draw"
        return True

    # ── การอ่าน ─────────────────────────────────────────────────────────────

    async def recent_matches(self, player_id: str, limit: int = 20) -> list[dict[str, Any]]:
        async with self.database.session() as session:
            matches = await session.scalars(
                select(Match)
                .join(MatchPlayer)
                .where(MatchPlayer.player_id == player_id)
                .order_by(Match.started_at.desc())
                .limit(max(1, min(100, limit)))
                .options(selectinload(Match.players))
            )
            return [
                {
                    "id": match.id,
                    "gameId": match.game_id,
                    "source": match.source,
                    "mode": match.mode,
                    "ranked": match.ranked,
                    "reason": match.reason,
                    "turns": match.turns,
                    "startedAt": match.started_at.isoformat(),
                    "endedAt": match.ended_at.isoformat() if match.ended_at else None,
                    "players": [
                        {
                            "seat": seat.seat,
                            "name": seat.name,
                            "score": seat.score,
                            "winner": seat.winner,
                            "isBot": seat.is_bot,
                            "ratingBefore": seat.rating_before,
                            "ratingAfter": seat.rating_after,
                        }
                        for seat in match.players
                    ],
                }
                for match in matches.all()
            ]
