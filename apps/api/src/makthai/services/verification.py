"""ยืนยันอีเมลด้วยรหัสหกหลัก

อีเมลที่ยังไม่ยืนยันเล่นได้ทุกอย่าง แค่แมตช์นั้นจะไม่นับอันดับ ซึ่งกันการสมัครรัว ๆ
เพื่อปั่นอันดับไปในตัว โดยไม่กีดขวางคนที่แค่อยากเล่น
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from makthai.db.models import OtpCode, Player
from makthai.services.accounts import UserView, normalize_email, to_view

OTP_LENGTH = 6
OTP_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5


def generate_code() -> str:
    return f"{secrets.randbelow(10**OTP_LENGTH):0{OTP_LENGTH}d}"


def hash_code(email: str, code: str) -> str:
    """แฮชก่อนเก็บ และผูกกับอีเมลด้วย เพื่อไม่ให้รหัสของคนหนึ่งเอาไปใช้กับอีกคนได้

    ใช้ SHA-256 ไม่ใช่ argon2 เพราะรหัสมีอายุสั้นมากและต้องตรวจถี่
    """
    return hashlib.sha256(f"{normalize_email(email)}:{code}".encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class IssuedCode:
    ok: bool
    code: str = ""
    minutes: int = 0
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class VerifyResult:
    ok: bool
    user: UserView | None = None
    code: str | None = None


class Verification:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def issue(self, email: str, purpose: str = "verify_email") -> IssuedCode:
        """ออกรหัสใหม่ และยกเลิกรหัสเก่าของอีเมลนี้ทิ้ง

        ไม่ให้มีรหัสหลายตัวใช้ได้พร้อมกัน ซึ่งเพิ่มโอกาสเดาถูกโดยไม่จำเป็น
        """
        normalized = normalize_email(email)
        player = await self.session.scalar(select(Player).where(Player.email == normalized))
        if player is None:
            return IssuedCode(ok=False, reason="email_not_found")
        if purpose == "verify_email" and player.email_verified_at is not None:
            return IssuedCode(ok=False, reason="email_already_verified")

        await self.session.execute(
            delete(OtpCode).where(
                OtpCode.email == normalized,
                OtpCode.purpose == purpose,
                OtpCode.consumed_at.is_(None),
            )
        )
        code = generate_code()
        self.session.add(
            OtpCode(
                email=normalized,
                code_hash=hash_code(normalized, code),
                purpose=purpose,
                expires_at=datetime.now(UTC) + OTP_TTL,
            )
        )
        await self.session.commit()
        return IssuedCode(ok=True, code=code, minutes=int(OTP_TTL.total_seconds() // 60))

    async def verify(self, email: str, code: str, purpose: str = "verify_email") -> VerifyResult:
        normalized = normalize_email(email)
        record = await self.session.scalar(
            select(OtpCode)
            .where(
                OtpCode.email == normalized,
                OtpCode.purpose == purpose,
                OtpCode.consumed_at.is_(None),
            )
            .order_by(OtpCode.created_at.desc())
        )
        if record is None:
            return VerifyResult(ok=False, code="otp_invalid")

        if record.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
            await self.session.delete(record)
            await self.session.commit()
            return VerifyResult(ok=False, code="otp_invalid")

        if record.attempts >= MAX_ATTEMPTS:
            # กรอกผิดจนครบโควตาแล้ว ทิ้งรหัสนี้ไปเลย ต้องขอใหม่
            await self.session.delete(record)
            await self.session.commit()
            return VerifyResult(ok=False, code="otp_too_many_attempts")

        if not hmac.compare_digest(record.code_hash, hash_code(normalized, str(code))):
            record.attempts += 1
            await self.session.commit()
            return VerifyResult(ok=False, code="otp_invalid")

        record.consumed_at = datetime.now(UTC)
        # รับรหัสจากกล่องจดหมายได้ก็คือคุมอีเมลนี้อยู่จริง ไม่ว่าจะขอมาด้วยเหตุใด
        player = await self.session.scalar(select(Player).where(Player.email == normalized))
        if player is None:
            return VerifyResult(ok=False, code="email_not_found")
        player.email_verified_at = datetime.now(UTC)
        await self.session.commit()
        return VerifyResult(ok=True, user=to_view(player))
