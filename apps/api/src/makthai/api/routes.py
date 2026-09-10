"""เส้นทาง HTTP ของแพลตฟอร์ม"""

from __future__ import annotations

from fastapi import APIRouter

from makthai.api.schemas import ConfigResponse, GameListResponse, GameSummary, HealthResponse
from makthai.config import get_settings
from makthai.games import registry
from makthai.messages import DEFAULT_LOCALE, LOCALES, catalog_for, resolve_locale

API_VERSION = 1
#: เวอร์ชันของโปรโตคอลเรียลไทม์ — เพิ่มเมื่อ client เก่ารับไม่ได้
PROTOCOL_VERSION = 1

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(ok=True, app=settings.app_name, games=len(registry))


@router.get("/api/v1/config", response_model=ConfigResponse, tags=["system"])
async def config() -> ConfigResponse:
    """client เรียกอันนี้ก่อนเสมอ เพื่อเทียบเวอร์ชันและรู้ว่าเซิร์ฟเวอร์มีอะไรบ้าง"""
    settings = get_settings()
    return ConfigResponse(
        api_version=API_VERSION,
        protocol_version=PROTOCOL_VERSION,
        environment=settings.environment,
        locales=list(LOCALES),
        default_locale=DEFAULT_LOCALE,
        games=registry.ids,
    )


@router.get("/api/v1/messages", tags=["system"])
async def messages(locale: str = DEFAULT_LOCALE) -> dict[str, object]:
    """แคตตาล็อกข้อความ — client จะดึงไปใช้หรือจะแปลเองก็ได้"""
    chosen = resolve_locale(locale)
    return {"locale": chosen, "available": list(LOCALES), "messages": catalog_for(chosen)}


@router.get("/api/v1/games", response_model=GameListResponse, tags=["games"])
async def games() -> GameListResponse:
    """รายการเกมทั้งหมดในแพลตฟอร์ม พร้อมยอดสด"""
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
            )
            for definition in registry.all()
        ]
    )
