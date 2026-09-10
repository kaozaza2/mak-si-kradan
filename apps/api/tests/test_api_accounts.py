"""บัญชีผู้ใช้ผ่าน HTTP จริง — ตอบเป็นรหัสเสมอ ไม่ใช่ข้อความ"""

import re

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from makthai.main import create_app


@pytest_asyncio.fixture
async def client(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("AUTH_SECRET", "test-secret-that-is-long-enough")
    from makthai.config import get_settings

    get_settings.cache_clear()
    app = create_app()
    transport = ASGITransport(app=app)
    async with (
        AsyncClient(transport=transport, base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        # ติดแอปไว้กับ client เพื่อให้เทสต์อ่านกล่องจดหมายของ ConsoleMailer ได้
        ac.app = app
        yield ac
    get_settings.cache_clear()


def last_email(client: AsyncClient):
    """อีเมลฉบับล่าสุดที่ระบบส่งออกไป ตอนพัฒนาเก็บไว้ในหน่วยความจำ"""
    return client.app.state.mailer.sent[-1]


def code_in(body: str) -> str:
    match = re.search(r"\b(\d{6})\b", body)
    assert match, f"ไม่พบรหัสหกหลักในอีเมล: {body}"
    return match.group(1)


async def register(client: AsyncClient, email: str, name: str = "ผู้เล่น") -> dict:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "password1234", "displayName": name},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_การตั้งค่าบอกว่าเปิดระบบบัญชีแล้ว(client):
    body = (await client.get("/api/v1/config")).json()
    assert body["accounts"] is True


async def test_สมัครแล้วได้โทเคนที่ใช้เรียก_me_ได้(client):
    created = await register(client, "api@example.com", "เอพีไอ")
    assert created["user"]["rating"] == 1200
    assert created["user"]["verified"] is False

    me = await client.get("/api/v1/me", headers={"authorization": f"Bearer {created['token']}"})
    assert me.status_code == 200
    assert me.json()["user"]["name"] == "เอพีไอ"


async def test_ล็อกอินผิดตอบเป็นรหัสไม่ใช่ข้อความ(client):
    await register(client, "login@example.com")
    response = await client.post(
        "/api/v1/auth/login", json={"email": "login@example.com", "password": "wrongwrongwrong"}
    )
    assert response.status_code == 401
    body = response.json()
    assert body == {"code": "invalid_credentials"}, "ต้องไม่มีข้อความภาษาคนใน payload"


async def test_ข้อมูลไม่ถูกต้องตอบเป็นรหัส(client):
    response = await client.post(
        "/api/v1/auth/register", json={"email": "a@example.com", "password": "sh0rt"}
    )
    assert response.status_code == 409
    assert response.json()["code"] == "weak_password"


async def test_เรียก_me_โดยไม่มีโทเคนถูกปฏิเสธ(client):
    response = await client.get("/api/v1/me")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


async def test_ค้นหาผู้เล่นต้องล็อกอินก่อน(client):
    anonymous = await client.get("/api/v1/players/search?q=someone")
    assert anonymous.status_code == 401

    created = await register(client, "search@example.com", "คนค้นหา")
    await register(client, "target@example.com", "เป้าหมาย")
    found = await client.get(
        "/api/v1/players/search?q=เป้าหมาย",
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert found.status_code == 200
    assert [player["name"] for player in found.json()["players"]] == ["เป้าหมาย"]


async def test_อันดับว่างเปล่าเมื่อยังไม่มีใครเล่น(client):
    await register(client, "board@example.com")
    assert (await client.get("/api/v1/leaderboard")).json()["leaderboard"] == []


async def test_ประวัติของผู้เล่นที่ยังไม่เคยเล่นเป็นรายการว่าง(client):
    created = await register(client, "hist@example.com")
    response = await client.get(f"/api/v1/players/{created['user']['id']}/matches")
    assert response.json()["matches"] == []


# ── ลืมรหัสผ่าน ─────────────────────────────────────────────────────────────


async def forgot(client: AsyncClient, email: str) -> str:
    response = await client.post("/api/v1/auth/forgot-password", json={"email": email})
    assert response.json() == {"ok": True, "code": "otp_sent"}
    return code_in(last_email(client).body)


async def test_ลืมรหัสผ่านแล้วตั้งใหม่ได้แล้วล็อกอินด้วยรหัสใหม่(client):
    await register(client, "forgot@example.com")
    code = await forgot(client, "forgot@example.com")

    response = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": "forgot@example.com", "code": code, "password": "brand-new-password"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["code"] == "password_changed"

    old = await client.post(
        "/api/v1/auth/login", json={"email": "forgot@example.com", "password": "password1234"}
    )
    assert old.status_code == 401
    new = await client.post(
        "/api/v1/auth/login",
        json={"email": "forgot@example.com", "password": "brand-new-password"},
    )
    assert new.status_code == 200


async def test_อีเมลตั้งรหัสผ่านใหม่คนละฉบับกับอีเมลยืนยัน(client):
    await register(client, "twomails@example.com")
    verification = last_email(client)
    await forgot(client, "twomails@example.com")
    reset = last_email(client)

    assert verification.subject != reset.subject
    assert verification.body != reset.body
    assert reset.to == "twomails@example.com"


async def test_รหัสตั้งรหัสผ่านใหม่ใช้ได้ครั้งเดียว(client):
    await register(client, "once@example.com")
    code = await forgot(client, "once@example.com")
    body = {"email": "once@example.com", "code": code, "password": "brand-new-password"}

    assert (await client.post("/api/v1/auth/reset-password", json=body)).status_code == 200
    again = await client.post("/api/v1/auth/reset-password", json=body)
    assert again.status_code == 400
    assert again.json() == {"code": "otp_invalid"}


async def test_รหัสผ่านใหม่ที่อ่อนเกินไปไม่กินรหัสจากอีเมลทิ้ง(client):
    await register(client, "weak@example.com")
    code = await forgot(client, "weak@example.com")

    weak = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": "weak@example.com", "code": code, "password": "sh0rt"},
    )
    assert weak.json() == {"code": "weak_password"}

    # รหัสเดิมยังใช้ได้ ไม่ต้องไปขอใหม่เพราะพิมพ์รหัสผ่านสั้นไปครั้งเดียว
    good = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": "weak@example.com", "code": code, "password": "brand-new-password"},
    )
    assert good.status_code == 200


async def test_รหัสยืนยันอีเมลเอามาตั้งรหัสผ่านใหม่ไม่ได้(client):
    created = await register(client, "mixup@example.com")
    assert created["verificationRequired"] is True
    verification_code = code_in(last_email(client).body)

    response = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "email": "mixup@example.com",
            "code": verification_code,
            "password": "brand-new-password",
        },
    )
    assert response.json() == {"code": "otp_invalid"}


async def test_อีเมลที่ไม่มีบัญชีตอบเหมือนกันและไม่มีอีเมลถูกส่ง(client):
    """ไม่งั้นใช้ทางนี้ไล่เช็คได้ว่าอีเมลไหนสมัครไว้แล้ว"""
    await register(client, "real@example.com")
    before = len(client.app.state.mailer.sent)

    response = await client.post(
        "/api/v1/auth/forgot-password", json={"email": "ghost@example.com"}
    )
    assert response.json() == {"ok": True, "code": "otp_sent"}
    assert len(client.app.state.mailer.sent) == before


async def test_ตั้งรหัสผ่านใหม่แล้วนับว่ายืนยันอีเมลแล้วด้วย(client):
    """รับรหัสจากกล่องจดหมายได้ก็คือคุมอีเมลนี้อยู่จริง"""
    await register(client, "proof@example.com")
    code = await forgot(client, "proof@example.com")

    response = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": "proof@example.com", "code": code, "password": "brand-new-password"},
    )
    assert response.json()["user"]["verified"] is True
