import pytest
from httpx import ASGITransport, AsyncClient

from makthai.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_health_บอกจำนวนเกมในทะเบียน(client):
    response = await client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["games"] >= 1


async def test_config_บอกเวอร์ชันและรายชื่อเกม(client):
    body = (await client.get("/api/v1/config")).json()
    assert body["apiVersion"] == 1
    assert body["protocolVersion"] == 1
    assert "mak-si-kradan" in body["games"]
    assert body["defaultLocale"] == "th"


async def test_รายการเกมมาจากทะเบียนโดยตรง(client):
    body = (await client.get("/api/v1/games")).json()
    game = next(g for g in body["games"] if g["id"] == "mak-si-kradan")
    assert game["minPlayers"] == 2
    assert game["maxPlayers"] == 4
    assert game["hasBots"] is True
    assert "assisted" in game["modes"]
    # ไม่มีข้อความภาษาคนอยู่ใน payload เลย ชื่อเกมมาจากแคตตาล็อกข้อความ
    assert "name" not in game


async def test_แคตตาล็อกข้อความมีครบทุกภาษา(client):
    th = (await client.get("/api/v1/messages?locale=th")).json()
    en = (await client.get("/api/v1/messages?locale=en")).json()
    assert th["locale"] == "th" and en["locale"] == "en"
    assert th["messages"]["game_mak-si-kradan"] == "หมากสี่กระดาน"
    assert th["messages"]["not_your_turn"] != en["messages"]["not_your_turn"]
    assert set(th["messages"]) == set(en["messages"])
    # ภาษาที่ไม่รองรับตกกลับมาเป็นค่าเริ่มต้น ไม่ใช่พัง
    assert (await client.get("/api/v1/messages?locale=fr")).json()["locale"] == "th"
