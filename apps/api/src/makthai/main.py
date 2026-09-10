"""จุดเริ่มของแอป"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from makthai import __version__
from makthai.api.routes import RateLimiter, router
from makthai.auth import resolve_secret
from makthai.config import get_settings
from makthai.db.session import create_database
from makthai.games import registry
from makthai.realtime.hub import Hub
from makthai.realtime.match import Match
from makthai.realtime.ws import serve
from makthai.services.accounts import Accounts
from makthai.services.history import History, MatchOutcome, MatchRecord, SeatRecord

logger = logging.getLogger(__name__)


class DatabaseSink:
    """ต่อเหตุการณ์ในเกมเข้ากับการบันทึกประวัติ

    ทุกอย่างเป็น fire-and-forget ที่ต่อคิวกันเป็นสายเดียว การเขียนลงฐานข้อมูล
    จึงไม่มีวันทำให้เกมสะดุด และลำดับไม่สลับกัน
    """

    def __init__(self, history: History) -> None:
        self.history = history

    def match_started(self, match: Match, seats: list[dict[str, Any]]) -> None:
        self.history.schedule(
            self.history.start_match(
                MatchRecord(
                    id=match.id,
                    game_id=match.game.id,
                    source="quick",
                    mode=match.mode,
                    turn_seconds=match.turn_seconds,
                    ranked=match.ranked,
                    seats=[
                        SeatRecord(
                            seat=seat["seat"],
                            player_id=seat["playerId"],
                            name=seat["name"],
                            is_bot=seat["isBot"],
                            bot_level=seat["botLevel"],
                        )
                        for seat in seats
                    ],
                )
            )
        )

    def turns_played(self, match: Match, turns: list[dict[str, Any]]) -> None:
        self.history.schedule(self.history.record_turns(match.id, turns))

    def match_finished(self, match: Match, outcome: dict[str, Any]) -> None:
        self.history.schedule(
            self.history.finish_match(
                match.id,
                MatchOutcome(
                    reason=outcome["reason"],
                    scores=outcome["scores"],
                    winners=outcome["winners"],
                    retired=outcome["retired"],
                    turns=outcome["turns"],
                ),
            )
        )


def create_app() -> FastAPI:
    settings = get_settings()
    secret, ephemeral = resolve_secret(settings.auth_secret)
    if ephemeral:
        logger.warning(
            "ไม่ได้ตั้ง AUTH_SECRET จึงสุ่มใหม่ทุกครั้งที่รีสตาร์ต ผู้เล่นจะหลุดตัวตน และหลายโหนดจะตรวจโทเคนของกันไม่ได้"
        )

    database = create_database(settings.database_url)
    history = History(database) if database else None
    if database is None:
        logger.warning("ไม่ได้ตั้ง DATABASE_URL จะไม่มีบัญชีผู้ใช้ ไม่มีอันดับ และไม่เก็บประวัติ")

    hub = Hub(
        registry,
        auth_secret=secret,
        public_url=settings.public_url,
        turn_seconds=settings.turn_seconds,
        sink=DatabaseSink(history) if history else None,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if database is not None:
            await database.create_all()
        yield
        if history is not None:
            # เขียนงานที่ค้างให้จบก่อนปิด ไม่งั้นเทิร์นท้าย ๆ จะหายไปจากประวัติ
            await history.flush()
        if database is not None:
            await database.dispose()

    app = FastAPI(
        title="mak-thai",
        version=__version__,
        description="แพลตฟอร์มเกมกระดานออนไลน์",
        lifespan=lifespan,
    )
    # client อื่น (แอปมือถือ) ต่อเข้ามาจากคนละ origin และใช้ bearer token ไม่ใช่ cookie
    # การเปิดกว้างจึงไม่เปิดช่อง CSRF
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type", "authorization"],
    )
    app.include_router(router)

    app.state.hub = hub
    app.state.database = database
    app.state.history = history
    app.state.auth_secret = secret
    app.state.limiter = RateLimiter()

    @app.websocket("/ws")
    async def websocket_endpoint(socket: WebSocket) -> None:
        await serve(socket, hub)

    return app


app = create_app()


__all__ = ["Accounts", "app", "create_app"]
