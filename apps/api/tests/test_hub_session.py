"""ตัวตน การกลับเข้าเกม และรายการต่าง ๆ"""

from hub_harness import HubHarness
from makthai.realtime import PROTOCOL_VERSION


def test_เล่นได้ทันทีโดยไม่ต้องสมัคร():
    harness = HubHarness()
    conn = harness.connect()
    session = conn.last("session")
    assert session["kind"] == "guest"
    assert session["id"].startswith("guest_")
    assert session["name"].startswith("Guest ")
    assert session["token"]


def test_ตั้งชื่อเองได้และชื่อติดไปกับโทเคน():
    harness = HubHarness()
    conn = harness.connect(name="เก้า")
    assert conn.last("session")["name"] == "เก้า"

    harness.send(conn, {"type": "set_name", "name": "เก้าใหม่"})
    assert conn.last("session")["name"] == "เก้าใหม่"


def test_โทเคนเดิมได้ตัวตนเดิมกลับมา():
    harness = HubHarness()
    first = harness.connect(name="เก้า")
    token = first.session_token
    harness.hub.disconnect(first)

    second = harness.connect(token=token)
    assert second.last("session")["id"] == first.last("session")["id"]
    assert second.last("session")["name"] == "เก้า"


def test_เวอร์ชันโปรโตคอลไม่ตรงได้คำตอบที่อ่านรู้เรื่อง():
    harness = HubHarness()
    conn = harness.connect()
    conn.clear()
    harness.hub.handle(conn, {"type": "hello", "protocol": PROTOCOL_VERSION + 1})
    error = conn.last("error")
    assert error["code"] == "protocol_mismatch"
    assert error["params"]["server"] == PROTOCOL_VERSION


def test_สั่งอะไรก่อนทักทายไม่ได้():
    harness = HubHarness()
    conn = harness.connect()
    conn.session_id = None
    conn.clear()
    harness.send(conn, {"type": "list_games"})
    assert conn.last("error")["code"] == "no_session"


def test_คำสั่งที่ไม่รู้จักถูกปฏิเสธพร้อมบอกว่าคำสั่งอะไร():
    harness = HubHarness()
    conn = harness.connect()
    harness.send(conn, {"type": "ทำอะไรไม่รู้"})
    error = conn.last("error")
    assert error["code"] == "unknown_command"
    assert error["params"]["action"] == "ทำอะไรไม่รู้"


def test_ข้อความที่ไม่ใช่รูปแบบที่รับได้ไม่ทำให้ระเบิด():
    harness = HubHarness()
    conn = harness.connect()
    for bad in (None, [], "hello", {"no_type": 1}, {"type": 5}):
        harness.hub.handle(conn, bad)
    assert conn.last("error")["code"] == "invalid_message"


def test_รายการเกมมาจากทะเบียนพร้อมยอดสด():
    harness = HubHarness()
    conn = harness.connect()
    harness.send(conn, {"type": "list_games"})
    games = conn.last("games")["games"]
    game = next(g for g in games if g["id"] == "mak-si-kradan")
    assert game["minPlayers"] == 2
    assert game["hasBots"] is True
    assert game["playing"] == 0
    # ไม่มีข้อความภาษาคนใน payload ชื่อเกมมาจากแคตตาล็อกข้อความ
    assert "name" not in game


def test_ยอดคนออนไลน์นับเฉพาะคนจริง():
    harness = HubHarness()
    first = harness.connect(name="A")
    harness.connect(name="B")
    assert first.last("lobby")["online"] == 2

    harness.send(first, {"type": "play_ai", "level": "easy"})
    # บอทไม่ถูกนับเป็นคนออนไลน์
    assert first.last("lobby")["online"] == 2
