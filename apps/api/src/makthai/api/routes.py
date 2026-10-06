"""เส้นทาง HTTP ของแพลตฟอร์ม

ตอบเป็นรหัสเสมอเมื่อผิดพลาด ไม่ใช่ข้อความ เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร
และ client ควรตัดสินใจจากรหัส ไม่ใช่เทียบสตริงที่พังทันทีที่แก้คำพูด
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from makthai import PROTOCOL_VERSION
from makthai.api.schemas import (
    ConfigResponse,
    DependencyStatus,
    GameListResponse,
    GameSummary,
    HealthResponse,
    ReadyResponse,
)
from makthai.auth import Identity, looks_like_session, sign_token, verify_token
from makthai.config import get_settings
from makthai.games import registry
from makthai.limits import Clock, WindowCounter
from makthai.mailer import otp_email
from makthai.messages import DEFAULT_LOCALE, LOCALES, catalog_for, resolve_locale
from makthai.services.accounts import Accounts, check_password
from makthai.services.friends import Friends
from makthai.services.sessions import Sessions
from makthai.services.verification import Verification

API_VERSION = 1

#: เพดานจำนวนรายการที่ endpoint รายการจะคืน
#: ค่า limit ที่ client ส่งมาเป็นตัวเลขอิสระ ถ้าไม่จำกัดก็ยิงมาครั้งเดียวด้วยเลขใหญ่ ๆ
#: แล้วให้ฐานข้อมูลทำงานหนักโดยไม่ได้อะไรกลับมา ขอบเขตนี้พอกับที่หน้าจอใช้จริง
MAX_PAGE_SIZE = 100

#: ความยาวสูงสุดของคำค้นที่รับได้
#: คำค้นยาวมากไม่ได้ทำให้ผลดีขึ้น แต่ทำให้ต้องแปะงานเยอะทุกครั้ง
MAX_QUERY_LENGTH = 64

#: ตรวจ dependency ได้นานเท่าไรก่อนถือว่าไม่ตอบ
#: ต้องสั้นกว่า timeout ของ probe ที่ orchestrator ตั้งไว้
#: ไม่งั้นถ้าฐานข้อมูลค้าง เราจะช้ากว่าที่มันควรตอบว่าไม่พร้อม
PROBE_TIMEOUT = 3.0

#: ล็อกอินพลาดได้กี่ครั้งต่อบัญชีในหน้าต่างเวลานี้
#: ตัวเลขนี้คือสิ่งที่ทำให้เดารหัสผ่านแพง ไม่ใช่แค่ข้อจำกัดความถี่
#: ให้พอให้พิมพ์ผิดได้หลายครั้ง แต่ให้เดายากจนไม่คุ้มที่จะเดา
LOGIN_ATTEMPTS = 8
LOGIN_WINDOW = 900.0

router = APIRouter()
logger = logging.getLogger(__name__)


def fail(code: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status)


def bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header.removeprefix("Bearer ").strip() or None


async def identity_of(request: Request) -> Identity | None:
    """คืนตัวตนจากโทเคนที่แนบมา ไม่งั้นคืน None

    ต้องรองรับโทเคนสองแบบ: เซสชันของบัญชี (ตรวจฝั่งเซิร์ฟเวอร์ ยกเลิกได้)
    และ token ของผู้เล่นชั่วคราว (เซ็นเอง ไม่ต้องแตะฐานข้อมูล)
    ตรวจรูปแบบจากตัวโทเคนก่อน ไม่งั้นจะเสียเวลาไปเปิดฐานข้อมูลทุกครั้ง
    """
    token = bearer(request)
    if not token:
        return None

    if looks_like_session(token):
        database = request.app.state.database
        if database is None:
            return None
        # เปิดครั้งเดียวจบ สองคิวรีต่อคำขอคือการรอที่ไม่จำเป็น
        async with database.session() as session:
            player_id = await Sessions(session).resolve(token)
            if player_id is None:
                return None
            # ชื่ออ่านจากตารางผู้เล่น ไม่ใช่จากโทเคน
            # เพราะผู้เล่นเปลี่ยนชื่อได้ และชื่อในโทเคนจะค้างจนกว่าจะออกใหม่
            user = await Accounts(session).get(player_id)
        if user is None:
            return None
        return Identity(id=player_id, name=user.name, kind="user", expires_at=0.0)

    return verify_token(token, request.app.state.auth_secret)


class RateLimiter:
    """จำกัดจำนวนครั้งของ endpoint ที่ยิงเดารหัสผ่านได้

    ตั้ง redis_url เมื่อไหร่จะนับรวมกันทั้งคลัสเตอร์ ไม่งั้นโควตาจะคูณตามจำนวนเครื่อง
    ซึ่งเท่ากับไม่ได้จำกัดอะไรเลยเมื่อกระจายหลายโหนด

    ตัวนับในเครื่องคีย์จาก IP ซึ่งผู้โจมตีควบคุมได้ จึงต้องมีขอบเขตเสมอ
    รายละเอียดของการกวาดและเพดานอยู่ที่ WindowCounter ซึ่งใช้ร่วมกับการคุม WebSocket
    """

    def __init__(self, redis_url: str = "", clock: Clock | None = None) -> None:
        self.redis_url = redis_url
        self._local = WindowCounter(clock, on_reset=self._warn_reset)
        self._redis: Any = None

    async def allow(self, key: str, limit: int, window: float) -> bool:
        if self.redis_url:
            shared = await self._allow_shared(key, limit, window)
            if shared is not None:
                return shared
            # Redis ล่มก็ถอยไปนับของเครื่องตัวเอง จำกัดหลวมกว่าเดิมแต่ยังจำกัดอยู่
            # ดีกว่าปล่อยผ่านทั้งหมด และดีกว่าปิดประตูใส่ทุกคนเพราะแคชล่ม
        return self._local.allow(key, limit, window)

    def reset(self, key: str) -> None:
        """ล้างโควตาเมื่อรู้แล้วว่าผู้ใช้ทำถูกต้อง เช่น ล็อกอินสำเร็จ

        มิฉะนั้นผู้ใช้ที่พิมพ์ผิดสองสามครั้งตอนเขียนรหัสจะเจอข้อจำกัดตอนกดส่งจริง
        ทั้งที่ไม่ได้ยิงผิดเลย
        """
        self._local.reset(key)

    def _warn_reset(self) -> None:
        logger.warning(
            "ตัวนับโควตาเต็ม %d คีย์ ล้างทิ้งทั้งหมด — โดนยิงจากแหล่งที่หลากหลายมาก",
            self._local.MAX_KEYS,
        )

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
    """ตอบว่ากระบวนการยังยังอยู่ — ใช้เป็น liveness probe

    ตั้งใจไม่แตะฐานข้อมูลหรือ Redis เพราะถ้า dependency สั่น
    แต่แอปยังไม่ตาย การดันก็ควรให้โอกาสฟื้นก่อน
    การตรวจว่ารับงานได้จริงอยู่ที่ /ready
    """
    return HealthResponse(ok=True, app=get_settings().app_name, games=len(registry))


@router.get("/ready", response_model=ReadyResponse, tags=["system"])
async def ready(request: Request) -> Any:
    """ตอบว่าโหนดนี้รับงานใหม่ได้หรือยัง — ใช้เป็น readiness probe

    คืน 503 เมื่อ dependency ที่จำเป็นใช้ไม่ได้ เพื่อให้ load balancer
    หยุดส่งผู้เล่นมาที่โหนดนี้ แต่ยังไม่ต้องรีสตาร์ต
    """
    database = request.app.state.database
    db_status = await _probe_database(database)
    cluster = request.app.state.hub.cluster
    cluster_status = _probe_cluster(cluster)
    ok = db_status.ok and cluster_status.ok
    return JSONResponse(
        ReadyResponse(ok=ok, database=db_status, cluster=cluster_status).model_dump(
            by_alias=True
        ),
        status_code=200 if ok else 503,
    )


async def _probe_database(database: Any) -> DependencyStatus:
    """ยิงคำสั่งจริงหนึ่งครั้ง ไม่ใช่แค่ดูว่าตัวแปรถูกตั้ง

    ข้อความบอกเหตุผลเป็นชื่อคลาสข้อผิดพลาดเท่านั้น ไม่ใส่รายละเอียดของการเชื่อมต่อ
    เพราะ endpoint นี้เปิดสาธารณะ ข้อความที่ละเอียดอาจบอกที่อยู่หรือชนิดฐานข้อมูลไปเปิดเผย
    """
    if database is None:
        # ไม่ได้ต่อฐานข้อมูลก็เล่นได้ครบทุกอย่าง แค่ไม่มีบัญชีและอันดับ จึงพร้อมใช้งาน
        return DependencyStatus(ok=True, detail="not_configured")
    try:
        await asyncio.wait_for(database.ping(), timeout=PROBE_TIMEOUT)
    except TimeoutError:
        return DependencyStatus(ok=False, detail="timeout")
    except Exception as error:
        return DependencyStatus(ok=False, detail=type(error).__name__)
    return DependencyStatus(ok=True, detail="ok")


def _probe_cluster(cluster: Any) -> DependencyStatus:
    if cluster is None:
        # ไม่ได้ตั้ง Redis = ทำงานโหนดเดียว ซึ่งเป็นการตั้งค่าที่ถูกต้อง
        return DependencyStatus(ok=True, detail="single_node")
    return DependencyStatus(ok=cluster.connected, detail="ok" if cluster.connected else "down")


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

    payload = await _authenticated(request, result.user)
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
    # จำกัดเฉพาะบัญชีที่กำลังถูกยิง ไม่ใช่ทั้ง IP
    # เพราะผู้โจมตีที่มี IP หลายเครื่องยิงผ่านข้อจำกัดราย IP ได้ แต่ถ้าล็อกตามชื่อบัญชี
    # เขาจะต้องแตะบัญชีนั้นถึงจะเดาได้ ทำให้เหลือแค่การโจมตีแบบกระจายที่แพงขึ้นมาก
    # ข้อความตอบเหมือนกันหมดเพื่อไม่ให้บอกว่าบัญชีนี้มีอยู่จริงหรือเปล่า
    account_key = f"login_account:{identifier.lower()}" if identifier else ""
    if account_key and not await allow(request, account_key, LOGIN_ATTEMPTS, LOGIN_WINDOW):
        return fail("rate_limited", 429)

    async with database.session() as session:
        result = await Accounts(session).login(identifier, str(body.get("password", "")))
    if not result.ok or result.user is None:
        return fail(result.code or "invalid_credentials", 401)
    # เข้าได้แล้วถือว่าพิมพ์ถูก เคลียร์โควตาทิ้ง ไม่งั้นผู้ใช้ที่พิมพ์ผิดตอนเขียนรหัส
    # จะเจอข้อจำกัดตอนกดส่งจริง ทั้งที่ไม่ได้ยิงผิดเลย
    if account_key:
        request.app.state.limiter.reset(account_key)
    return await _authenticated(request, result.user)


@router.get("/api/v1/me", tags=["accounts"])
async def me(request: Request) -> Any:
    database = request.app.state.database
    identity = await identity_of(request)
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
async def leaderboard(
    request: Request, limit: Annotated[int, Query(50, ge=1, le=MAX_PAGE_SIZE)]
) -> Any:
    database = request.app.state.database
    if database is None:
        return {"leaderboard": []}
    async with database.session() as session:
        return {"leaderboard": await Accounts(session).leaderboard(limit)}


@router.get("/api/v1/players/search", tags=["accounts"])
async def search_players(
    request: Request, q: Annotated[str, Query(max_length=MAX_QUERY_LENGTH)]
) -> Any:
    identity = await identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    if not await allow(request, "search", 30, 60):
        return fail("rate_limited", 429)
    database = request.app.state.database
    if database is None:
        return {"players": []}
    async with database.session() as session:
        return {"players": await Accounts(session).search(q, identity.id)}


@router.get("/api/v1/players/{player_id}/matches", tags=["accounts"])
async def player_matches(
    request: Request,
    player_id: str,
    limit: Annotated[int, Query(20, ge=1, le=MAX_PAGE_SIZE)],
) -> Any:
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
    return await _authenticated(request, result.user)


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
        # เปลี่ยนรหัสผ่านแล้วทุกเซสชันเดิมต้องตาย
        # ไม่งั้นคนที่รหัสเก่ายังอยู่ในมือถือที่หายไปจะยังเข้าได้ต่อ
        # ซึ่งเป็นการทำให้การเปลี่ยนรหัสผ่านใช้ไม่ได้ผลจริง
        revoked = 0
        if result.ok and result.user is not None:
            revoked = await Sessions(session).revoke_all(result.user.id)
    if not result.ok or result.user is None:
        return fail(result.code or "weak_password", 400)
    if revoked:
        logger.info("เปลี่ยนรหัสผ่านของ %s ปิดเซสชันเดิม %d อัน", result.user.id, revoked)

    payload = await _authenticated(request, result.user)
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
    return await _authenticated(request, result.user)


# ── เพื่อน ──────────────────────────────────────────────────────────────────


@router.get("/api/v1/friends", tags=["friends"])
async def list_friends(request: Request) -> Any:
    identity = await identity_of(request)
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


@router.post("/api/v1/auth/logout", tags=["accounts"])
async def logout(request: Request) -> Any:
    """ออกจากระบบ — ยกเลิกเซสชันนี้

    ต้องยกเลิกฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ลบออกจากเครื่อง ไม่งั้นโทเคนที่อาจถูก
    เก็บไว้ยังใช้ต่อได้จนหมดอายุ
    """
    token = bearer(request)
    database = request.app.state.database
    if token is None or database is None:
        # ไม่มีอะไรต้องทำ ตอบว่าสำเร็จเสมอ ไม่ให้คนเดาได้ว่าตัวเองมีโทเคนหรือไม่
        return {"ok": True}
    if not looks_like_session(token):
        # token ของผู้เล่นชั่วคราวยกเลิกไม่ได้ เพราะไม่มีสถานะให้ยกเลิก
        # แต่การลบทิ้งทำให้ผู้ใช้เป็นคนใหม่ ซึ่งถือว่าออกจากระบบแล้ว
        return {"ok": True}
    async with database.session() as session:
        await Sessions(session).revoke(token)
    return {"ok": True}


@router.post("/api/v1/auth/sessions", tags=["accounts"])
async def revoke_all_sessions(request: Request) -> Any:
    """ปิดทุกอุปกรณ์ — ใช้เมื่อรู้ว่ามีคนอื่นใช้บัญชีนี้อยู่"""
    identity = await identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    async with database.session() as session:
        closed = await Sessions(session).revoke_all(identity.id)
        # ออกโทเคนใหม่ให้ใช้ต่อ ไม่งั้นคนที่เพิ่งสั่งจะถูกตัดออกตัวเองด้วย
        issued = await Sessions(session).issue(identity.id, ttl=_session_ttl())
    return {"ok": True, "closed": closed, "token": issued.token}


@router.post("/api/v1/friends/request", tags=["friends"])
async def request_friend(request: Request) -> Any:
    identity = await identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)
    if not await allow(request, "friend_request", 20, 300):
        return fail("rate_limited", 429)

    body = await _json(request)
    async with database.session() as session:
        result = await Friends(session).request(identity.id, str(body.get("identifier", "")))
    if not result.ok:
        return fail(result.code or "player_not_found", 400)
    return {"status": result.status, "player": result.player}


@router.post("/api/v1/friends/respond", tags=["friends"])
async def respond_friend(request: Request) -> Any:
    identity = await identity_of(request)
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
    identity = await identity_of(request)
    if identity is None:
        return fail("unauthorized", 401)
    database = request.app.state.database
    if database is None:
        return fail("accounts_disabled", 400)

    body = await _json(request)
    async with database.session() as session:
        removed = await Friends(session).remove(identity.id, str(body.get("playerId", "")))
    return {"ok": removed}


def _session_ttl() -> timedelta:
    return timedelta(days=get_settings().session_ttl_days)


async def _authenticated(request: Request, user: Any) -> dict[str, Any]:
    """ออกโทเคนให้ผู้ใช้ที่เพิ่งเข้าสู่ระบบ

    บัญชีได้เซสชันฝั่งเซิร์ฟเวอร์ เพื่อให้ยกเลิกได้เมื่อเปลี่ยนรหัสผ่านหรือถูกแบน
    ไม่ใช้ token ที่เซ็นเอง เพราะตัวนั้นยกเลิกไม่ได้
    """
    database = request.app.state.database
    if database is not None:
        async with database.session() as session:
            issued = await Sessions(session).issue(user.id, ttl=_session_ttl())
        if issued.ok:
            return {"token": issued.token, "user": user.as_dict()}
        logger.error("ออกเซสชันให้ %s ไม่สำเร็จ", user.id)
    # ออกโทเคนแบบเดิมไว้เป็นทางสำรอง ดีกว่าให้ล็อกอินไม่ได้เลย
    # ทั้งที่รหัสผ่านถูกต้อง แต่ต้องบันทึกไว้ว่าเราเลือกทางสำรอง
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
