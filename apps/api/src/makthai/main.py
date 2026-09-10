"""จุดเริ่มของแอป"""

from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from makthai import __version__
from makthai.api.routes import router
from makthai.auth import resolve_secret
from makthai.config import get_settings
from makthai.games import registry
from makthai.realtime.hub import Hub
from makthai.realtime.ws import serve

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    settings = get_settings()
    secret, ephemeral = resolve_secret(settings.auth_secret)
    if ephemeral:
        logger.warning(
            "ไม่ได้ตั้ง AUTH_SECRET จึงสุ่มใหม่ทุกครั้งที่รีสตาร์ต ผู้เล่นจะหลุดตัวตน และหลายโหนดจะตรวจโทเคนของกันไม่ได้"
        )

    app = FastAPI(
        title="mak-thai",
        version=__version__,
        description="แพลตฟอร์มเกมกระดานออนไลน์",
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

    hub = Hub(
        registry,
        auth_secret=secret,
        public_url=settings.public_url,
        turn_seconds=settings.turn_seconds,
    )
    app.state.hub = hub

    @app.websocket("/ws")
    async def websocket_endpoint(socket: WebSocket) -> None:
        await serve(socket, hub)

    return app


app = create_app()
