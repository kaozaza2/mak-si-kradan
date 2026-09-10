"""ระบบบัญชีทั้งวงผ่านอีเมลจริง

ยิงอีเมลออกทาง SMTP จริงเข้ากล่องจดหมายทดสอบ แล้วอ่านรหัสกลับมาจากกล่องนั้น
เทสต์อื่นใช้ ConsoleMailer ซึ่งข้ามการส่งจริงไป ตัวนี้จึงเป็นที่เดียวที่พิสูจน์ว่า
SmtpMailer ประกอบอีเมลถูกและส่งออกไปได้จริง

ข้ามไปเงียบ ๆ เมื่อไม่ได้เปิดกล่องจดหมายไว้ จะได้ไม่บังคับให้ทุกคนต้องรัน Docker:

    docker compose -f docker-compose.dev.yml up -d
"""

from __future__ import annotations

import re

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from makthai.main import create_app

MAILPIT = "http://localhost:8025"
SMTP_PORT = 1025


def mailpit_running() -> bool:
    try:
        return httpx.get(f"{MAILPIT}/api/v1/info", timeout=1).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(
    not mailpit_running(), reason="ไม่ได้เปิดกล่องจดหมายทดสอบไว้ — ดูคำอธิบายบนหัวไฟล์"
)


@pytest_asyncio.fixture
async def client(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'inbox.db'}")
    monkeypatch.setenv("AUTH_SECRET", "test-secret-that-is-long-enough")
    monkeypatch.setenv("SMTP_HOST", "localhost")
    monkeypatch.setenv("SMTP_PORT", str(SMTP_PORT))
    from makthai.config import get_settings

    get_settings.cache_clear()
    httpx.delete(f"{MAILPIT}/api/v1/messages", timeout=5)

    app = create_app()
    assert app.state.mailer.name == "smtp", "ตั้ง SMTP_HOST แล้วต้องได้ SmtpMailer"
    async with (
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        yield ac
    get_settings.cache_clear()


async def inbox_code(to: str) -> str:
    """รหัสหกหลักจากอีเมลฉบับล่าสุดที่ส่งถึงคนนี้"""
    async with httpx.AsyncClient(base_url=MAILPIT, timeout=5) as mail:
        listing = (await mail.get("/api/v1/search", params={"query": f"to:{to}"})).json()
        assert listing["messages"], f"ไม่มีอีเมลถึง {to} ในกล่องจดหมาย"
        message = (await mail.get(f"/api/v1/message/{listing['messages'][0]['ID']}")).json()
    match = re.search(r"\b(\d{6})\b", message["Text"])
    assert match, f"ไม่พบรหัสหกหลักในอีเมล: {message['Text']}"
    return match.group(1)


async def test_สมัครแล้วรหัสยืนยันไปถึงกล่องจดหมายจริง(client):
    email = "signup@mak-thai.test"
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": "password1234"}
    )
    assert created.json()["verificationRequired"] is True

    verified = await client.post(
        "/api/v1/auth/verify-otp", json={"email": email, "code": await inbox_code(email)}
    )
    assert verified.status_code == 200, verified.text
    assert verified.json()["user"]["verified"] is True


async def test_ลืมรหัสผ่านครบวงผ่านอีเมลจริง(client):
    email = "reset@mak-thai.test"
    await client.post("/api/v1/auth/register", json={"email": email, "password": "password1234"})

    await client.post("/api/v1/auth/forgot-password", json={"email": email})
    changed = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": email, "code": await inbox_code(email), "password": "brand-new-password"},
    )
    assert changed.status_code == 200, changed.text

    stale = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "password1234"}
    )
    assert stale.status_code == 401
    fresh = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "brand-new-password"}
    )
    assert fresh.status_code == 200


async def test_อีเมลที่ส่งออกไปอ่านรู้เรื่องและระบุผู้ส่งชัดเจน(client):
    """อีเมลเป็นข้อความที่คนอ่านจริง ต่างจาก packet ที่ส่งแค่รหัส"""
    email = "readable@mak-thai.test"
    await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "password1234", "locale": "en"},
    )
    async with httpx.AsyncClient(base_url=MAILPIT, timeout=5) as mail:
        listing = (await mail.get("/api/v1/search", params={"query": f"to:{email}"})).json()
        message = (await mail.get(f"/api/v1/message/{listing['messages'][0]['ID']}")).json()

    assert message["From"]["Address"] == "no-reply@mak-thai.local"
    assert "mak-thai" in message["Subject"], "ขอภาษาอังกฤษมาก็ต้องได้อังกฤษ"
    assert "minutes" in message["Text"]
