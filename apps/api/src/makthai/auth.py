"""ตัวตนของผู้เล่น

token มีแบบเดียวใช้ทั้งผู้เล่นชั่วคราวและบัญชีที่สมัคร เซ็นด้วย HMAC และพก id
กับชื่อไว้ในตัว การยืนยันตัวตนจึงไม่ต้องแตะฐานข้อมูลเลย ซึ่งจำเป็นเมื่อกระจาย
หลาย node — node ไหนก็ตรวจ token ได้ตราบใดที่ถือ secret เดียวกัน
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Literal

TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

Kind = Literal["guest", "user"]


@dataclass(frozen=True, slots=True)
class Identity:
    id: str
    name: str
    kind: Kind
    expires_at: float


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(body: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def sign_token(
    identity_id: str, name: str, kind: Kind, secret: str, ttl: int = TOKEN_TTL_SECONDS
) -> str:
    payload = {"sub": identity_id, "name": name, "kind": kind, "exp": time.time() + ttl}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body, secret)}"


def verify_token(token: str | None, secret: str) -> Identity | None:
    """คืนตัวตนเมื่อ token ถูกต้องทุกประการ ไม่งั้นคืน None"""
    if not token or "." not in token:
        return None
    body, _, signature = token.rpartition(".")
    # เทียบแบบเวลาคงที่ กัน timing attack ที่ค่อย ๆ เดาลายเซ็นทีละไบต์
    if not hmac.compare_digest(signature, _sign(body, secret)):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None

    if payload.get("kind") not in ("guest", "user"):
        return None
    if not isinstance(payload.get("sub"), str) or not payload["sub"]:
        return None
    if not isinstance(payload.get("exp"), int | float) or payload["exp"] < time.time():
        return None
    return Identity(
        id=payload["sub"],
        name=str(payload.get("name", "")),
        kind=payload["kind"],
        expires_at=float(payload["exp"]),
    )


def new_guest_id() -> str:
    return f"guest_{secrets.token_hex(3)}"


GUEST_NAMES = (
    "Fox",
    "Tiger",
    "Moon",
    "Comet",
    "Otter",
    "Falcon",
    "Panda",
    "Koi",
    "Nova",
    "Heron",
    "Lynx",
    "Maple",
    "Rider",
    "Sable",
    "Wren",
    "Zephyr",
)


def new_guest_name() -> str:
    return f"Guest {secrets.choice(GUEST_NAMES)}"


def sanitize_name(raw: object, fallback: str) -> str:
    """ตัดชื่อที่ผู้เล่นตั้งเองให้อยู่ในขอบเขตที่ปลอดภัยต่อการแสดงผล"""
    if not isinstance(raw, str):
        return fallback
    cleaned = "".join(ch for ch in raw if ch.isprintable()).strip()[:20]
    return cleaned or fallback


def resolve_secret(configured: str) -> tuple[str, bool]:
    """คืน secret ที่ใช้ได้ พร้อมบอกว่าเป็นค่าสุ่มชั่วคราวหรือไม่

    ไม่ตั้งไว้แล้วสุ่มใหม่ทุกครั้งที่รีสตาร์ต แปลว่าทุกคนหลุดล็อกอิน
    และหลาย node จะตรวจ token ของกันและกันไม่ได้
    """
    if configured and len(configured) >= 16:
        return configured, False
    return secrets.token_hex(32), True


def room_code(length: int = 6) -> str:
    """ตัวอักษรที่อ่านผิดยาก (ไม่มีเลขศูนย์ โอ หนึ่ง ไอ) เพราะต้องบอกกันปากเปล่า"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))
