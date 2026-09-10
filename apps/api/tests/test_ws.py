"""ทดสอบผ่าน WebSocket จริงของ FastAPI"""

from fastapi.testclient import TestClient

from makthai.main import app


def read_until(socket, kind: str, limit: int = 30) -> dict:
    for _ in range(limit):
        message = socket.receive_json()
        if message.get("type") == kind:
            return message
    raise AssertionError(f"ไม่ได้รับข้อความชนิด {kind}")


def test_ทักทายแล้วได้ตัวตนกับข้อมูล_lobby():
    with TestClient(app) as client, client.websocket_connect("/ws") as socket:
        socket.send_json({"type": "hello", "name": "เก้า"})
        session = read_until(socket, "session")
        assert session["name"] == "เก้า"
        assert session["token"]

        lobby = read_until(socket, "lobby")
        assert lobby["online"] >= 1
        assert any(game["id"] == "mak-si-kradan" for game in lobby["games"])


def test_ข้อความที่ไม่ใช่_json_ไม่ทำให้หลุด():
    with TestClient(app) as client, client.websocket_connect("/ws") as socket:
        socket.send_json({"type": "hello"})
        read_until(socket, "session")
        socket.send_text("ไม่ใช่ json")
        assert read_until(socket, "error")["code"] == "not_json"


def test_เล่นกับบอทผ่านสายจริงแล้วบอทเดินตอบ():
    with TestClient(app) as client, client.websocket_connect("/ws") as socket:
        socket.send_json({"type": "hello", "name": "เก้า"})
        read_until(socket, "session")
        socket.send_json({"type": "play_ai", "level": "easy"})

        start = read_until(socket, "match_start")
        assert start["gameId"] == "mak-si-kradan"
        state = read_until(socket, "state")["state"]
        assert len(state["view"]["board"]) == 64


def test_สองคนจับคู่กันผ่านสายจริง():
    with (
        TestClient(app) as client,
        client.websocket_connect("/ws") as first,
        client.websocket_connect("/ws") as second,
    ):
        first.send_json({"type": "hello", "name": "A"})
        read_until(first, "session")
        first.send_json({"type": "quick_match"})
        read_until(first, "queue")

        second.send_json({"type": "hello", "name": "B"})
        read_until(second, "session")
        second.send_json({"type": "quick_match"})

        start_b = read_until(second, "match_start")
        start_a = read_until(first, "match_start")
        assert start_a["matchId"] == start_b["matchId"]
        assert start_a["you"] != start_b["you"]
