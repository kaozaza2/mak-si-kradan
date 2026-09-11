"""เส้นทาง HTTP ของแพลตฟอร์ม

ตอบเป็นรหัสเสมอเมื่อผิดพลาด ไม่ใช่ข้อความ เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร
และ client ควรตัดสินใจจากรหัส ไม่ใช่เทียบสตริงที่พังทันทีที่แก้คำพูด
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from makthai import PROTOCOL_VERSION
from makthai.api.schemas import ConfigResponse, GameListResponse, GameSummary, HealthResponse
from makthai.auth import sign_token, verify_token
from makthai.config import get_settings
from makthai.games import registry
from makthai.mailer import otp_email
from makthai.messages import DEFAULT_LOCALE, LOCALES, catalog_for, resolve_locale
from makthai.services.accounts import Accounts, check_password
from makthai.services.friends import Friends
from makthai.services.verification import Verification

API_VERSION = 1

router = APIRouter()
logger = logging.getLogger(__name__)


def fail(code: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status)


def bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header.removeprefix("Bearer ").strip() or None


def identity_of(request: Request) -> Any:
    return verify_token(bearer(request), request.app.state.auth_secret)


class RateLimiter:
    """จำกัดจำนวนครั้งของ endpoint ที่ยิงเดารหัสผ่านได้

    ตั้ง redis_url เมื่อไหร่จะนับรวมกันทั้งคลัสเตอร์ ไม่งั้นโควตาจะคูณตามจำนวนเครื่อง
    ซึ่งเท่ากับไม่ได้จำกัดอะไรเลยเมื่อกระจายหลายโหนด
    """

    def __init__(self, redis_url: str = "") -> None:
        self.redis_url = redis_url
        self._hits: dict[str, tuple[int, float]] = {}
        self._redis: Any = None

    async def allow(self, key: str, limit: int, window: float) -> bool:
        if self.redis_url:
            shared = await self._allow_shared(key, limit, window)
            if shared is not None:
                return shared
            # Redis ล่มก็ถอยไปนับของเครื่องตัวเอง จำกัดหลวมกว่าเดิมแต่ยังจำกัดอยู่
            # ดีกว่าปล่อยผ่านทั้งหมด และดีกว่าปิดประตูใส่ทุกคนเพราะแคชล่ม
        return self._allow_local(key, limit, window)

    def _allow_local(self, key: str, limit: int, window: float) -> bool:
        now = time.monotonic()
        count, reset_at = self._hits.get(key, (0, 0.0))
        if reset_at < now:
            self._hits[key] = (1, now + window)
            return True
        self._hits[key] = (count + 1, reset_at)
        return count + 1 <= limit

    async def _allow_shared(self, key: str, limit: int, window: float) -> bool | None:
        try:
            if self._redis is None:
                import redis.asyncio as redis

                self._redis = redis.from_url(self.redis_url, decode_responses=True)
            # นับกับตั้งอายุในรอบเดียว สองเครื่องยิงพร้อมกันก็ไม่นับหาย
            pipeline = self._redis.pipeline()
            pipeline.incr(f"ratelimit:{key}")
            pipeline.expire(f"ratelimit:{key}", int(window), nx=True)
            count, _ = await pipeline.execute()
        except Exception:
            logger.warning("นับโควตาที่ Redis ไม่สำเร็จ ถอยไปนับของเครื่องตัวเอง")
            return None
        return int(count) <= limit

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None


async def allow(request: Request, key: str, limit: int, window: float) -> bool:
    """ตัวนับอยู่บนแอปไม่ใช่ระดับโมดูล ทุกอินสแตนซ์จึงมีโควตาของตัวเอง"""
    who = request.client.host if request.client else "unknown"
    limiter: RateLimiter = request.app.state.limiter
    allowed = await limiter.allow(f"{key}:{who}", limit, window)
    return bool(allowed)


# ── ระบบ ────────────────────────────────────────────────────────────────────


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    return HealthResponse(ok=True, app=get_settings().app_name, games=len(registry))


@router.get("/api/v1/config", response_model=ConfigResponse, tags=["system"])
async def config(request: Request) -> ConfigResponse:
    """client เรียกอันนี้ก่อนเสมอ เพื่อเทียบเวอร์ชันและรู้ว่าเซิร์ฟเวอร์มีอะไรบ้าง"""
    settings = get_settings()
    # บอก client id เฉพาะเมื่อฝั่งเซิร์ฟเวอร์ตรวจโทเคนของ client id นั้นได้จริง
    # ไม่งั้นหน้าเว็บจะขึ้นปุ่มที่กดแล้วล็อกอินไม่ผ่านแน่ ๆ
    web_client_id = settings.google_web_client_id.strip()
    google_ready = bool(web_client_id) and web_client_id in settings.google_client_id_list
    return ConfigResponse(
        api_version=API_VERSION,
        protocol_version=PROTOCOL_VERSION,
        environment=settings.environment,
        locales=list(LOCALES),
        default_locale=DEFAULT_LOCALE,
        games=registry.ids,
        accounts=request.app.state.database is not None,
        google_client_id=web_client_id if google_ready else None,
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
    if not await allow(request, "register", 5, 3600):
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

    payload = _authenticated(request, result.user)
    if result.user.email and not result.user.verified:
        await _send_otp(request, result.user.email, _locale_of(request, body))
        payload["verificationRequired"] = True
        payload["code"] = "verification_sent"
    return payload


@router.post("/api/v1/auth/login", tags=["accounts"])
async def login(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    if not await allow(request, "login", 10, 600):
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


@router.post("/api/v1/auth/verify-otp", tags=["accounts"])
async def verify_otp(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    email = str(body.get("email", ""))
    if not await allow(request, f"otp:{email}", 10, 900):
        return fail("rate_limited", 429)

    async with database.session() as session:
        result = await Verification(session).verify(email, str(body.get("code", "")))
    if not result.ok or result.user is None:
        return fail(result.code or "otp_invalid", 400)
    return _authenticated(request, result.user)


@router.post("/api/v1/auth/resend-otp", tags=["accounts"])
async def resend_otp(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    email = str(body.get("email", ""))
    if not await allow(request, f"resend:{email}", 3, 900):
        return fail("rate_limited", 429)

    await _send_otp(request, email, _locale_of(request, body))
    # ตอบเหมือนกันเสมอ จะได้ไม่ใช้ทางนี้ไล่เช็คว่าอีเมลไหนมีบัญชีอยู่
    return {"ok": True, "code": "otp_sent"}


@router.post("/api/v1/auth/forgot-password", tags=["accounts"])
async def forgot_password(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    email = str(body.get("email", ""))
    if not await allow(request, f"forgot:{email}", 3, 900):
        return fail("rate_limited", 429)

    await _send_otp(request, email, _locale_of(request, body), "reset_password")
    # ตอบเหมือนกันเสมอ จะได้ไม่ใช้ทางนี้ไล่เช็คว่าอีเมลไหนมีบัญชีอยู่
    return {"ok": True, "code": "otp_sent"}


@router.post("/api/v1/auth/reset-password", tags=["accounts"])
async def reset_password(request: Request) -> Any:
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    email = str(body.get("email", ""))
    if not await allow(request, f"reset:{email}", 10, 900):
        return fail("rate_limited", 429)

    # ตรวจรหัสผ่านใหม่ก่อนแตะรหัสจากอีเมล ไม่งั้นพิมพ์รหัสผ่านสั้นไปทีเดียว
    # ก็เสียรหัสจากอีเมลไปเปล่า ๆ ต้องไปขอใหม่ทั้งที่กรอกรหัสถูกแล้ว
    password = str(body.get("password", ""))
    problem = check_password(password)
    if problem:
        return fail(problem, 400)

    async with database.session() as session:
        checked = await Verification(session).verify(
            email, str(body.get("code", "")), "reset_password"
        )
        if not checked.ok:
            return fail(checked.code or "otp_invalid", 400)

        # ตั้งรหัสใหม่ในเซสชันเดียวกับที่ตัดรหัสทิ้ง รหัสหนึ่งใบจึงเปลี่ยนได้ครั้งเดียว
        result = await Accounts(session).set_password(email, password)
    if not result.ok or result.user is None:
        return fail(result.code or "weak_password", 400)

    payload = _authenticated(request, result.user)
    payload["code"] = "password_changed"
    return payload


@router.post("/api/v1/auth/google", tags=["accounts"])
async def google_login(request: Request) -> Any:
    verifier = request.app.state.google
    if not verifier.enabled:
        return fail("google_disabled", 400)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    if not await allow(request, "google", 20, 600):
        return fail("rate_limited", 429)

    body = await _json(request)
    identity = await verifier.verify(body.get("idToken"))
    if identity is None:
        return fail("google_invalid", 401)

    async with database.session() as session:
        result = await Accounts(session).login_with_google(identity)
    if not result.ok or result.user is None:
        return fail(result.code or "google_invalid", 401)
    return _authenticated(request, result.user)


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


def _locale_of(request: Request, body: dict[str, Any]) -> str:
    """ภาษาที่ผู้ใช้อยากได้ — จาก body หรือส่วนหัวของคำขอ"""
    if body.get("locale") in LOCALES:
        return str(body["locale"])
    header = request.headers.get("accept-language", "").lower()
    return "th" if header.startswith("th") else DEFAULT_LOCALE


async def _send_otp(
    request: Request, email: str, locale: str, purpose: str = "verify_email"
) -> None:
    """ส่งรหัสทางอีเมล — ไม่บอกผู้เรียกว่าอีเมลมีอยู่จริงไหม"""
    database = request.app.state.database
    async with database.session() as session:
        issued = await Verification(session).issue(email, purpose)
    if not issued.ok:
        return
    try:
        await request.app.state.mailer.send(
            otp_email(email, issued.code, issued.minutes, locale, purpose)
        )
    except Exception:
        logger.exception("ส่งอีเมลไม่สำเร็จ")


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
