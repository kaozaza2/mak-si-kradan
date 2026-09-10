"""เส้นทาง HTTP ของแพลตฟอร์ม

ตอบเป็นรหัสเสมอเมื่อผิดพลาด ไม่ใช่ข้อความ เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร
และ client ควรตัดสินใจจากรหัส ไม่ใช่เทียบสตริงที่พังทันทีที่แก้คำพูด
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from makthai.api.schemas import ConfigResponse, GameListResponse, GameSummary, HealthResponse
from makthai.auth import sign_token, verify_token
from makthai.config import get_settings
from makthai.games import registry
from makthai.messages import DEFAULT_LOCALE, LOCALES, catalog_for, resolve_locale
from makthai.services.accounts import Accounts
from makthai.services.friends import Friends

API_VERSION = 1
#: เวอร์ชันของโปรโตคอลเรียลไทม์ — เพิ่มเมื่อ client เก่ารับไม่ได้
PROTOCOL_VERSION = 1

router = APIRouter()


def fail(code: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status)


def bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header.removeprefix("Bearer ").strip() or None


def identity_of(request: Request) -> Any:
    return verify_token(bearer(request), request.app.state.auth_secret)


class RateLimiter:
    """จำกัดจำนวนครั้งของ endpoint ที่ยิงเดารหัสผ่านได้

    เก็บในหน่วยความจำของโหนดเดียว พอสำหรับกันสคริปต์เดาสุ่ม แต่ถ้ากระจายหลายโหนด
    ควรย้ายไปนับรวมกันที่ Redis
    """

    def __init__(self) -> None:
        self._hits: dict[str, tuple[int, float]] = {}

    def allow(self, key: str, limit: int, window: float) -> bool:
        now = time.monotonic()
        count, reset_at = self._hits.get(key, (0, 0.0))
        if reset_at < now:
            self._hits[key] = (1, now + window)
            return True
        self._hits[key] = (count + 1, reset_at)
        return count + 1 <= limit


def allow(request: Request, key: str, limit: int, window: float) -> bool:
    """ตัวนับอยู่บนแอปไม่ใช่ระดับโมดูล ทุกอินสแตนซ์จึงมีโควตาของตัวเอง"""
    who = request.client.host if request.client else "unknown"
    return request.app.state.limiter.allow(f"{key}:{who}", limit, window)


# ── ระบบ ────────────────────────────────────────────────────────────────────


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    return HealthResponse(ok=True, app=get_settings().app_name, games=len(registry))


@router.get("/api/v1/config", response_model=ConfigResponse, tags=["system"])
async def config(request: Request) -> ConfigResponse:
    """client เรียกอันนี้ก่อนเสมอ เพื่อเทียบเวอร์ชันและรู้ว่าเซิร์ฟเวอร์มีอะไรบ้าง"""
    return ConfigResponse(
        api_version=API_VERSION,
        protocol_version=PROTOCOL_VERSION,
        environment=get_settings().environment,
        locales=list(LOCALES),
        default_locale=DEFAULT_LOCALE,
        games=registry.ids,
        accounts=request.app.state.database is not None,
    )


@router.get("/api/v1/messages", tags=["system"])
async def messages(locale: str = DEFAULT_LOCALE) -> dict[str, object]:
    """แคตตาล็อกข้อความ — client จะดึงไปใช้หรือจะแปลเองก็ได้"""
    chosen = resolve_locale(locale)
    return {"locale": chosen, "available": list(LOCALES), "messages": catalog_for(chosen)}


@router.get("/api/v1/games", response_model=GameListResponse, tags=["games"])
async def games(request: Request) -> GameListResponse:
    """รายการเกมทั้งหมดพร้อมยอดสด"""
    live = {summary["id"]: summary for summary in request.app.state.hub.game_summaries()}
    return GameListResponse(
        games=[
            GameSummary(
                id=definition.id,
                icon=definition.icon,
                min_players=definition.min_players,
                max_players=definition.max_players,
                default_turn_seconds=definition.default_turn_seconds,
                modes=list(definition.modes),
                bot_levels=list(definition.bot_levels),
                has_bots=definition.has_bots,
                playing=live.get(definition.id, {}).get("playing", 0),
                open_rooms=live.get(definition.id, {}).get("openRooms", 0),
            )
            for definition in registry.all()
        ]
    )


# ── บัญชีผู้ใช้ ──────────────────────────────────────────────────────────────


@router.post("/api/v1/auth/register", tags=["accounts"])
async def register(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    if not allow(request, "register", 5, 3600):
        return fail("rate_limited", 429)

    body = await _json(request)
    async with database.session() as session:
        result = await Accounts(session).register(
            email=str(body.get("email", "")),
            username=str(body.get("username", "")),
            password=str(body.get("password", "")),
            display_name=str(body.get("displayName", "")),
        )
    if not result.ok or result.user is None:
        return fail(result.code or "invalid_credentials", 409)
    return _authenticated(request, result.user)


@router.post("/api/v1/auth/login", tags=["accounts"])
async def login(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    if not allow(request, "login", 10, 600):
        return fail("rate_limited", 429)

    body = await _json(request)
    identifier = str(body.get("email") or body.get("username") or "")
    async with database.session() as session:
        result = await Accounts(session).login(identifier, str(body.get("password", "")))
    if not result.ok or result.user is None:
        return fail(result.code or "invalid_credentials", 401)
    return _authenticated(request, result.user)


@router.get("/api/v1/me", tags=["accounts"])
async def me(request: Request) -> Any:
    database = request.app.state.database
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    if database is None:
        return fail("accounts_disabled", 400)
    async with database.session() as session:
        user = await Accounts(session).get(identity.id)
    if user is None:
        return fail("user_not_found", 404)
    return {"user": user.as_dict()}


@router.get("/api/v1/leaderboard", tags=["accounts"])
async def leaderboard(request: Request, limit: int = 50) -> Any:
    database = request.app.state.database
    if database is None:
        return {"leaderboard": []}
    async with database.session() as session:
        return {"leaderboard": await Accounts(session).leaderboard(limit)}


@router.get("/api/v1/players/search", tags=["accounts"])
async def search_players(request: Request, q: str = "") -> Any:
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return {"players": []}
    async with database.session() as session:
        return {"players": await Accounts(session).search(q, identity.id)}


@router.get("/api/v1/players/{player_id}/matches", tags=["accounts"])
async def player_matches(request: Request, player_id: str, limit: int = 20) -> Any:
    history = request.app.state.history
    if history is None:
        return {"matches": []}
    return {"matches": await history.recent_matches(player_id, limit)}


# ── เพื่อน ──────────────────────────────────────────────────────────────────


@router.get("/api/v1/friends", tags=["friends"])
async def list_friends(request: Request) -> Any:
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    async with database.session() as session:
        listing = await Friends(session).listing(identity.id)
    # สถานะออนไลน์รู้ได้จาก hub เท่านั้น ฐานข้อมูลไม่รู้ว่าใครต่ออยู่
    online = request.app.state.hub.online_ids({friend["id"] for friend in listing["friends"]})
    return {
        **listing,
        "friends": [{**friend, "online": friend["id"] in online} for friend in listing["friends"]],
    }


@router.post("/api/v1/friends/request", tags=["friends"])
async def request_friend(request: Request) -> Any:
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    async with database.session() as session:
        result = await Friends(session).request(identity.id, str(body.get("identifier", "")))
    if not result.ok:
        return fail(result.code or "player_not_found", 400)
    return {"status": result.status, "player": result.player}


@router.post("/api/v1/friends/respond", tags=["friends"])
async def respond_friend(request: Request) -> Any:
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    try:
        request_id = int(body.get("requestId", 0))
    except (TypeError, ValueError):
        return fail("friend_request_gone", 400)

    async with database.session() as session:
        result = await Friends(session).respond(identity.id, request_id, bool(body.get("accept")))
    if not result.ok:
        return fail(result.code or "friend_request_gone", 400)
    return {"status": result.status, "player": result.player}


@router.post("/api/v1/friends/remove", tags=["friends"])
async def remove_friend(request: Request) -> Any:
    identity = identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    async with database.session() as session:
        removed = await Friends(session).remove(identity.id, str(body.get("playerId", "")))
    return {"ok": removed}


def _authenticated(request: Request, user: Any) -> dict[str, Any]:
    token = sign_token(user.id, user.name, "user", request.app.state.auth_secret)
    return {"token": token, "user": user.as_dict()}


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
