"""ล็อกอินด้วย Google

ใช้รูปแบบที่ client ฝั่งไหนก็ทำได้เหมือนกัน — เว็บ ไอโอเอส แอนดรอยด์ ต่างขอ ID token
จาก SDK ของแพลตฟอร์มตัวเอง แล้วส่งมาให้เซิร์ฟเวอร์ตรวจ ไม่ต้องมี redirect flow
ซึ่งจำเป็นสำหรับแอปมือถือ

ตรวจลายเซ็นเองด้วยกุญแจสาธารณะของ Google แทนการเรียก tokeninfo ทุกครั้ง
จะได้ไม่ต้องยิงออกนอกทุกการล็อกอิน
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any, cast

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
VALID_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
JWKS_TTL = 3600.0
#: เผื่อนาฬิกาคลาดกันเล็กน้อยระหว่างเครื่อง
CLOCK_SKEW = 300


@dataclass(frozen=True, slots=True)
class GoogleIdentity:
    sub: str
    email: str | None
    email_verified: bool
    name: str | None


def _b64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _int(value: str) -> int:
    return int.from_bytes(_b64(value), "big")


class GoogleVerifier:
    def __init__(
        self,
        client_ids: list[str],
        *,
        jwks_url: str = GOOGLE_JWKS_URL,
        fetch: Any = None,
        now: Any = time.time,
    ) -> None:
        self.client_ids = {value for value in client_ids if value}
        self.jwks_url = jwks_url
        self._fetch = fetch
        self._now = now
        self._keys: dict[str, dict[str, str]] = {}
        self._expires_at = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.client_ids)

    async def verify(self, id_token: object) -> GoogleIdentity | None:
        """คืนตัวตนเมื่อโทเคนถูกต้องทุกประการ ไม่งั้นคืน None"""
        if not self.enabled or not isinstance(id_token, str):
            return None
        parts = id_token.split(".")
        if len(parts) != 3:
            return None
        raw_header, raw_payload, raw_signature = parts

        try:
            header = json.loads(_b64(raw_header))
            payload = json.loads(_b64(raw_payload))
        except (ValueError, json.JSONDecodeError):
            return None

        # รับเฉพาะ RS256 ป้องกัน alg confusion เช่นการยัด alg none เข้ามา
        if header.get("alg") != "RS256" or not header.get("kid"):
            return None

        jwk = await self._key(str(header["kid"]))
        if jwk is None:
            return None
        if not self._signature_ok(jwk, f"{raw_header}.{raw_payload}", _b64(raw_signature)):
            return None

        if payload.get("iss") not in VALID_ISSUERS:
            return None
        if payload.get("aud") not in self.client_ids:
            return None
        sub = payload.get("sub")
        if not isinstance(sub, str) or not sub:
            return None

        now = int(self._now())
        exp = payload.get("exp")
        if not isinstance(exp, int | float) or exp <= now:
            return None
        iat = payload.get("iat")
        if isinstance(iat, int | float) and iat > now + CLOCK_SKEW:
            return None

        email = payload.get("email")
        return GoogleIdentity(
            sub=sub,
            email=email.lower() if isinstance(email, str) else None,
            email_verified=payload.get("email_verified") in (True, "true"),
            name=payload.get("name") if isinstance(payload.get("name"), str) else None,
        )

    def _signature_ok(self, jwk: dict[str, str], signed: str, signature: bytes) -> bool:
        try:
            numbers = rsa.RSAPublicNumbers(e=_int(jwk["e"]), n=_int(jwk["n"]))
            key = numbers.public_key()
            key.verify(signature, signed.encode(), padding.PKCS1v15(), hashes.SHA256())
        except Exception:
            return False
        return True

    async def _key(self, kid: str) -> dict[str, str] | None:
        if self._expires_at > self._now() and kid in self._keys:
            return self._keys[kid]
        # ไม่รู้จักกุญแจนี้ อาจเพราะ Google หมุนกุญแจ ลองโหลดใหม่หนึ่งครั้ง
        await self._refresh()
        return self._keys.get(kid)

    async def _refresh(self) -> None:
        try:
            body = await self._load()
        except Exception:
            # โหลดกุญแจไม่ได้ก็ปล่อยให้ verify คืน None ดีกว่าปล่อยผ่าน
            return
        keys = {
            key["kid"]: key
            for key in body.get("keys", [])
            if key.get("kty") == "RSA" and key.get("kid")
        }
        if keys:
            self._keys = keys
            self._expires_at = self._now() + JWKS_TTL

    async def _load(self) -> dict[str, Any]:
        if self._fetch is not None:
            body = await self._fetch(self.jwks_url)
            return cast(dict[str, Any], body)
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(self.jwks_url)
            response.raise_for_status()
            return cast(dict[str, Any], response.json())


__all__ = ["GOOGLE_JWKS_URL", "GoogleIdentity", "GoogleVerifier"]
