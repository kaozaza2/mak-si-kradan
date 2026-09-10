"""ตัวตรวจโทเคน Google

ทดสอบด้วยกุญแจที่สร้างเอง ทำให้ตรวจเส้นทางลายเซ็นและ claim ได้จริงโดยไม่ต้องยิงไปหา Google
"""

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from makthai.services.google import GoogleVerifier

CLIENT_ID = "123.apps.googleusercontent.com"

private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
numbers = private_key.public_key().public_numbers()


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def to_b64_int(value: int) -> str:
    return b64(value.to_bytes((value.bit_length() + 7) // 8, "big"))


JWK = {
    "kid": "test-key",
    "kty": "RSA",
    "alg": "RS256",
    "use": "sig",
    "n": to_b64_int(numbers.n),
    "e": to_b64_int(numbers.e),
}


def encode(value: dict) -> str:
    return b64(json.dumps(value).encode())


def make_token(claims: dict | None = None, *, kid: str = "test-key", alg: str = "RS256", key=None):
    header = encode({"alg": alg, "kid": kid, "typ": "JWT"})
    payload = encode(
        {
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "google-user-1",
            "email": "Player@Example.com",
            "email_verified": True,
            "name": "ผู้เล่นกูเกิล",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
            **(claims or {}),
        }
    )
    signature = (key or private_key).sign(
        f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )
    return f"{header}.{payload}.{b64(signature)}"


class Counter:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, _url: str) -> dict:
        self.calls += 1
        return {"keys": [JWK]}


@pytest.fixture
def verifier():
    return GoogleVerifier([CLIENT_ID], fetch=Counter())


async def test_โทเคนที่ถูกต้องผ่านและคืนอีเมลเป็นตัวพิมพ์เล็ก(verifier):
    identity = await verifier.verify(make_token())
    assert identity is not None
    assert identity.sub == "google-user-1"
    assert identity.email == "player@example.com"
    assert identity.email_verified is True
    assert identity.name == "ผู้เล่นกูเกิล"


async def test_ลายเซ็นจากกุญแจอื่นไม่ผ่าน(verifier):
    assert await verifier.verify(make_token(key=other_key)) is None


async def test_แก้เนื้อหาหลังเซ็นแล้วไม่ผ่าน(verifier):
    header, _, signature = make_token().split(".")
    tampered = f"{header}.{encode({'sub': 'attacker', 'aud': CLIENT_ID})}.{signature}"
    assert await verifier.verify(tampered) is None


async def test_alg_none_ไม่ผ่าน(verifier):
    """กัน alg confusion"""
    header = encode({"alg": "none", "kid": "test-key"})
    payload = encode({"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "x"})
    assert await verifier.verify(f"{header}.{payload}.") is None


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "someone-else.apps.googleusercontent.com"},
        {"iss": "https://evil.example.com"},
        {"exp": int(time.time()) - 10},
        {"sub": ""},
    ],
)
async def test_claim_ที่ไม่ถูกต้องไม่ผ่าน(verifier, claims):
    assert await verifier.verify(make_token(claims)) is None


async def test_กุญแจที่ไม่รู้จักไม่ผ่าน(verifier):
    assert await verifier.verify(make_token(kid="unknown")) is None


async def test_รับได้หลาย_client_id_เพราะเว็บกับมือถือใช้คนละตัว():
    verifier = GoogleVerifier(["mobile.apps.googleusercontent.com", CLIENT_ID], fetch=Counter())
    assert await verifier.verify(make_token()) is not None


async def test_ข้อมูลที่ไม่ใช่โทเคนไม่ทำให้ระเบิด(verifier):
    for bad in (None, "", "ไม่ใช่โทเคน", "a.b.c", 123):
        assert await verifier.verify(bad) is None


async def test_ไม่ตั้ง_client_id_คือปิดการล็อกอินด้วย_google():
    verifier = GoogleVerifier([])
    assert verifier.enabled is False
    assert await verifier.verify(make_token()) is None


async def test_แคชกุญแจไว้ไม่ยิงโหลดใหม่ทุกครั้ง():
    counter = Counter()
    verifier = GoogleVerifier([CLIENT_ID], fetch=counter)
    for _ in range(3):
        await verifier.verify(make_token())
    assert counter.calls == 1
