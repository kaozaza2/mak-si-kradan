"""เซสชันฝั่งเซิร์ฟเวอร์ของบัญชีผู้ใช้

เหตุผลที่ต้องมี: token แบบไม่มีสถานะถูกปลอมไม่ได้ ถ้าหลุดไปไม่มีทางยกเลิก
เปลี่ยนรหัสผ่านแล้ว token เก่ายังใช้ได้ต่อ ถ้าถูกแบนก็เข้าเกมต่อได้
เซสชันเก็บฝั่งเซิร์ฟเวอร์จึงยกเลิกได้จริง

ผู้เล่นชั่วคราวไม่ใช้เซสชัน — เขาไม่มีอันดับ ไม่มีประวัติ ไม่มีข้อมูลส่วนตัว
การยกเลิกเขาแล้วไม่ได้ปกป้องอะไร แต่จะทำให้การเล่นต้องมีฐานข้อมูล
ซึ่งขัดกับหลักที่โค้ดนี้ยึดไว้ ผู้เล่นชั่วคราวจึงใช้ token แบบเดิมที่เซ็นเอง

เก็บเฉพาะแฮชของโทเคน ไม่เก็บโทเคนจริง ฐานข้อมูลรั่วก็เอาไปใช้ไม่ได้
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from makthai.auth import SESSION_PREFIX, as_utc, looks_like_session
from makthai.db.models import PlayerSession, utcnow

#: ความยาวโทเคนสุ่ม ค่านี้คือความเดายากของเซสชัน ไม่ใช่ความยาวคีย์เข้ารหัส
TOKEN_BYTES = 32

DEFAULT_TTL = timedelta(days=30)

#: ตรวจทุกกี่ครั้งที่เรียกดูว่ามีเซสชันที่หมดอายุให้ลบ
CLEANUP_EVERY = 200


@dataclass(frozen=True, slots=True)
class IssuedSession:
    ok: bool
    token: str = ""
    expires_at: datetime | None = None
    code: str | None = None


def new_token() -> str:
    """สุ่มโทเคนที่เดายาก ผู้ใช้มองไม่ออกว่าจะเป็นอะไร"""
    return SESSION_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """แฮชโทเคนก่อนเก็บ

    ใช้ SHA-256 ไม่ใช่ argon2 เพราะโทเคนสุ่มทั้งหมด ไม่ใช่รหัสผ่านที่คนเลือกเอง
    การช้าลงจึงไม่ช่วยอะไรนัก แลกกับการค้นหาได้เร็วทุกคำขอ
    """
    return hashlib.sha256(token.encode()).hexdigest()


class Sessions:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self._calls = 0

    async def issue(self, player_id: str, ttl: timedelta = DEFAULT_TTL) -> IssuedSession:
        """ออกเซสชันใหม่ให้ผู้เล่นคนนั้น

        ไม่ลบเซสชันเก่า เพื่อให้เปิดหลายแท็บหรือหลายเครื่องได้
        ถ้าอยากให้มีเซสชันเดียวต้องเรียก revoke_all ก่อน
        """
        token = new_token()
        expires_at = datetime.now(UTC) + ttl
        self.session.add(
            PlayerSession(
                token_hash=hash_token(token),
                player_id=player_id,
                expires_at=expires_at,
            )
        )
        try:
            await self.session.commit()
        except Exception:
            await self.session.rollback()
            return IssuedSession(ok=False, code="session_failed")
        return IssuedSession(ok=True, token=token, expires_at=expires_at)

    async def resolve(self, token: str) -> str | None:
        """คืน id ของผู้เล่นเมื่อเซสชันยังใช้ได้ ไม่งั้นคืน None

        เซสชันถูกยกเลิกแล้ว หมดอายุแล้ว หรือไม่มีอยู่ ถือว่าใช้ไม่ได้ทั้งสิ้น
        """
        record = await self.session.scalar(
            select(PlayerSession).where(PlayerSession.token_hash == hash_token(token))
        )
        if record is None:
            return None
        if record.revoked_at is not None:
            return None
        if as_utc(record.expires_at) < datetime.now(UTC):
            return None

        # เติมทุกครั้งที่ใช้ ไม่งั้นจะรู้ไม่ได้ว่าเซสชันไหนยังมีคนใช้อยู่จริง
        record.last_seen_at = utcnow()
        await self.session.commit()
        await self._cleanup()
        return record.player_id

    async def revoke(self, token: str) -> bool:
        """ยกเลิกเซสชันเดียว ใช้ตอนออกจากระบบ"""
        result = await self._revoke_where(PlayerSession.token_hash == hash_token(token))
        return result > 0

    async def revoke_all(self, player_id: str) -> int:
        """ยกเลิกทุกเซสชันของผู้เล่นคนนั้น

        ใช้เมื่อเปลี่ยนรหัสผ่านหรือถูกแบน เพราะทุกทางที่เข้ามาต้องถูกปิด
        ไม่ใช่แค่ทางที่คนรู้
        """
        return await self._revoke_where(
            PlayerSession.player_id == player_id,
            PlayerSession.revoked_at.is_(None),
        )

    async def _revoke_where(self, *conditions: Any) -> int:
        """ยกเลิกเซสชันที่ตรงเงื่อนไข คืนจำนวนที่ปิดได้จริง

        ต้องรู้จำนวนที่ปิดได้ เพราะการนับผิดทำให้ผู้ใช้เชื่อว่าเครื่องอื่นถูกออกแล้ว
        ทั้งที่ยังไม่ได้ปิดเลย
        """
        statement = update(PlayerSession).where(*conditions).values(revoked_at=utcnow())
        # rowcount มีอยู่จริงบน CursorResult แต่ลายเซ็นของ execute ประกาศเป็น Result
        # จึงต้องยืนยันชนิด ไม่งั้น mypy --strict จะไม่ยอมให้อ่าน rowcount
        result = cast(CursorResult[Any], await self.session.execute(statement))
        await self.session.commit()
        return int(result.rowcount or 0)

    async def _cleanup(self) -> None:
        """ลบเซสชันที่หมดอายุหรือถูกยกเลิกทิ้ง ไม่ให้ตารางโตไม่จำกัด

        ทำเป็นระยะ ไม่ใช่ทุกครั้งที่เรียก เพราะการลบทุกครั้งจะช้าขึ้นตามขนาดตาราง
        และผู้ใช้ที่ยกเลิกเซสชันแล้วจะไม่รู้ว่าถูกลบ เพราะการเรียก resolve
        คืน None เหมือนกันทั้งที่ยังไม่ถูกลบและถูกลบแล้ว
        """
        self._calls += 1
        if self._calls % CLEANUP_EVERY:
            return
        # SQLite เก็บ datetime เป็นข้อความโดยไม่มีโซนเวลา
        # ถ้าเทียบกับเวลาที่มีโซนเวลา จะเปรียบเทียบผิดวิธีและลบผิดแถว
        cutoff = datetime.now(UTC)
        if self._is_sqlite():
            cutoff = cutoff.replace(tzinfo=None)
        await self.session.execute(delete(PlayerSession).where(PlayerSession.expires_at < cutoff))
        await self.session.commit()

    def _is_sqlite(self) -> bool:
        """เชื่อมต่อฐานข้อมูลนี้เป็น SQLite หรือไม่"""
        return self.session.bind is not None and self.session.bind.dialect.name == "sqlite"


__all__ = [
    "DEFAULT_TTL",
    "SESSION_PREFIX",
    "TOKEN_BYTES",
    "IssuedSession",
    "Sessions",
    "hash_token",
    "looks_like_session",
    "new_token",
]
