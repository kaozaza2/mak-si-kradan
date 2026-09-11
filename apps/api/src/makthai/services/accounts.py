"""บัญชีผู้ใช้

เล่นเป็นผู้เล่นชั่วคราวได้ทันทีเหมือนเดิม การสมัครเพิ่มให้แค่อันดับกับประวัติที่ผูก
กับตัวตนถาวร

ทุกฟังก์ชันคืน "รหัส" ไม่ใช่ข้อความ เพราะเซิร์ฟเวอร์ไม่รู้ว่าใครจะเอาไปแสดงด้วย
ภาษาอะไร
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from makthai.db.models import Player, utcnow
from makthai.rating import DEFAULT_RATING

_hasher = PasswordHasher()

USERNAME_PATTERN = re.compile(r"^[a-z0-9_]{3,20}$")
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$")
MIN_PASSWORD = 8
MAX_PASSWORD = 200


@dataclass(frozen=True, slots=True)
class UserView:
    id: str
    name: str
    username: str | None
    email: str | None
    verified: bool
    google: bool
    rating: int
    games_played: int
    wins: int
    losses: int
    draws: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "username": self.username,
            "email": self.email,
            "verified": self.verified,
            "google": self.google,
            "rating": self.rating,
            "gamesPlayed": self.games_played,
            "wins": self.wins,
            "losses": self.losses,
            "draws": self.draws,
        }


@dataclass(frozen=True, slots=True)
class AccountResult:
    ok: bool
    user: UserView | None = None
    code: str | None = None

    @staticmethod
    def failure(code: str) -> AccountResult:
        return AccountResult(ok=False, code=code)


def to_view(player: Player) -> UserView:
    return UserView(
        id=player.id,
        name=player.name,
        username=player.username,
        email=player.email,
        verified=player.verified,
        google=player.google_id is not None,
        rating=player.rating,
        games_played=player.games_played,
        wins=player.wins,
        losses=player.losses,
        draws=player.draws,
    )


def normalize_email(raw: object) -> str:
    return raw.strip().lower() if isinstance(raw, str) else ""


def normalize_username(raw: object) -> str:
    return raw.strip().lower() if isinstance(raw, str) else ""


def check_password(password: object) -> str | None:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        return "weak_password"
    if len(password) > MAX_PASSWORD:
        return "password_too_long"
    return None


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, ValueError):
        return False


class Accounts:
    """งานเกี่ยวกับบัญชีทั้งหมด ทำงานบนหนึ่ง session ที่ผู้เรียกเปิดมาให้"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _by_email(self, email: str) -> Player | None:
        player: Player | None = await self.session.scalar(
            select(Player).where(Player.email == email)
        )
        return player

    async def _by_username(self, username: str) -> Player | None:
        player: Player | None = await self.session.scalar(
            select(Player).where(Player.username == username)
        )
        return player

    async def register(
        self, *, email: str = "", username: str = "", password: str = "", display_name: str = ""
    ) -> AccountResult:
        """สมัครด้วยอีเมล หรือด้วยชื่อผู้ใช้ล้วนก็ได้"""
        problem = check_password(password)
        if problem:
            return AccountResult.failure(problem)

        email = normalize_email(email)
        username = normalize_username(username)

        if email:
            if not EMAIL_PATTERN.match(email):
                return AccountResult.failure("invalid_email")
            if await self._by_email(email):
                return AccountResult.failure("email_taken")
        elif username:
            if not USERNAME_PATTERN.match(username):
                return AccountResult.failure("invalid_username")
            if await self._by_username(username):
                return AccountResult.failure("username_taken")
        else:
            return AccountResult.failure("invalid_email")

        player = Player(
            id=f"user_{secrets.token_hex(8)}",
            name=display_name or (email.split("@")[0] if email else username),
            kind="user",
            email=email or None,
            username=username or None,
            password_hash=hash_password(password),
            rating=DEFAULT_RATING,
            # สมัครด้วยชื่อผู้ใช้ล้วนไม่มีอีเมลให้ยืนยัน จึงพร้อมใช้งานเลย
            email_verified_at=None if email else utcnow(),
        )
        self.session.add(player)
        await self.session.commit()
        return AccountResult(ok=True, user=to_view(player))

    async def login(self, identifier: str, password: str) -> AccountResult:
        value = identifier.strip().lower()
        player = await (self._by_email(value) if "@" in value else self._by_username(value))

        # ข้อความเดียวกันทั้งกรณีไม่มีบัญชีและรหัสผิด จะได้ไม่บอกใบ้ว่าชื่อไหนมีอยู่จริง
        if player is None:
            # ทำงานเท่า ๆ กันทั้งสองทาง กัน timing attack ที่ใช้เดาว่ามีบัญชีนี้ไหม
            verify_password(password, None)
            return AccountResult.failure("invalid_credentials")
        if not verify_password(password, player.password_hash):
            return AccountResult.failure("invalid_credentials")

        player.last_seen_at = utcnow()
        await self.session.commit()
        return AccountResult(ok=True, user=to_view(player))

    async def get(self, player_id: str) -> UserView | None:
        player = await self.session.get(Player, player_id)
        return to_view(player) if player and player.kind == "user" else None

    async def touch_guest(self, player_id: str, name: str, kind: str) -> None:
        """จำผู้เล่นชั่วคราวไว้ เพื่อให้ประวัติแมตช์อ้างถึงได้"""
        player = await self.session.get(Player, player_id)
        if player is None:
            self.session.add(Player(id=player_id, name=name, kind=kind))
        else:
            player.last_seen_at = utcnow()
            # บัญชีที่สมัครแล้วเปลี่ยนชื่อทางนี้ไม่ได้ ชื่อมาจากตอนสมัคร
            if player.kind != "user":
                player.name = name
        await self.session.commit()

    async def leaderboard(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = await self.session.scalars(
            select(Player)
            .where(Player.kind == "user", Player.games_played > 0)
            .order_by(Player.rating.desc(), Player.games_played.desc())
            .limit(max(1, min(200, limit)))
        )
        return [
            {**to_view(player).as_dict(), "rank": index + 1}
            for index, player in enumerate(rows.all())
        ]

    async def search(self, query: str, exclude_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """ค้นหาเพื่อเพิ่มเป็นเพื่อน — สั้นเกินไปไม่ค้น กันการดึงรายชื่อทั้งระบบ"""
        trimmed = query.strip().lower()
        if len(trimmed) < 2:
            return []
        pattern = f"%{trimmed}%"
        rows = await self.session.scalars(
            select(Player)
            .where(
                Player.kind == "user",
                Player.id != exclude_id,
                func.lower(Player.username).like(pattern) | func.lower(Player.name).like(pattern),
            )
            .order_by(Player.rating.desc())
            .limit(max(1, min(50, limit)))
        )
        return [
            {"id": p.id, "name": p.name, "username": p.username, "rating": p.rating}
            for p in rows.all()
        ]

    async def login_with_google(self, identity: Any) -> AccountResult:
        """ล็อกอินด้วย Google

        ถ้าอีเมลตรงกับบัญชีเดิมที่ยืนยันแล้วจะผูกเข้าด้วยกัน ไม่สร้างบัญชีซ้ำ
        แต่จะผูกก็ต่อเมื่อฝั่ง Google ยืนยันอีเมลนั้นแล้วเท่านั้น ไม่งั้นใครก็อ้าง
        อีเมลของคนอื่นเพื่อยึดบัญชีได้
        """
        linked = await self.session.scalar(select(Player).where(Player.google_id == identity.sub))
        if linked is not None:
            linked.last_seen_at = utcnow()
            await self.session.commit()
            return AccountResult(ok=True, user=to_view(linked))

        email = normalize_email(identity.email) if identity.email else None
        if email and identity.email_verified:
            existing = await self._by_email(email)
            if existing is not None:
                existing.google_id = identity.sub
                existing.email_verified_at = existing.email_verified_at or utcnow()
                await self.session.commit()
                return AccountResult(ok=True, user=to_view(existing))

        player = Player(
            id=f"user_{secrets.token_hex(8)}",
            name=identity.name or (email.split("@")[0] if email else "ผู้เล่น Google"),
            kind="user",
            email=email if identity.email_verified else None,
            google_id=identity.sub,
            email_verified_at=utcnow() if identity.email_verified else None,
            rating=DEFAULT_RATING,
        )
        self.session.add(player)
        await self.session.commit()
        return AccountResult(ok=True, user=to_view(player))

    async def set_password(self, email: str, password: str) -> AccountResult:
        """ตั้งรหัสผ่านใหม่ให้บัญชีที่พิสูจน์แล้วว่าคุมอีเมลนี้อยู่

        ผู้เรียกต้องตรวจรหัสจากอีเมลมาก่อน ตรงนี้ไม่ถามรหัสผ่านเดิม เพราะทางนี้มีไว้
        สำหรับคนที่จำรหัสเดิมไม่ได้อยู่แล้ว
        """
        problem = check_password(password)
        if problem:
            return AccountResult.failure(problem)
        player = await self._by_email(normalize_email(email))
        if player is None:
            return AccountResult.failure("email_not_found")
        player.password_hash = hash_password(password)
        await self.session.commit()
        return AccountResult(ok=True, user=to_view(player))

    async def mark_verified(self, email: str) -> AccountResult:
        player = await self._by_email(normalize_email(email))
        if player is None:
            return AccountResult.failure("email_not_found")
        player.email_verified_at = datetime.now(UTC)
        await self.session.commit()
        return AccountResult(ok=True, user=to_view(player))
