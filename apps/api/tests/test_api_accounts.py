"""บัญชีผู้ใช้ผ่าน HTTP จริง — ตอบเป็นรหัสเสมอ ไม่ใช่ข้อความ"""

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
        yield ac
    get_settings.cache_clear()


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
