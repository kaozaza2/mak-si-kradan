"""เครื่องมือสำหรับขับ hub ในเทสต์โดยไม่ต้องยกเซิร์ฟเวอร์จริง"""

from __future__ import annotations

import itertools
from typing import Any

from makthai.games import registry
from makthai.realtime import Hub, ManualScheduler

SECRET = "test-secret-that-is-long-enough"
_ids = itertools.count()


class FakeConnection:
    """การเชื่อมต่อปลอมที่แค่จดข้อความที่ถูกส่งออกไป"""

    def __init__(self) -> None:
        self.id = f"conn_{next(_ids)}"
        self.session_id: str | None = None
        self.messages: list[dict[str, Any]] = []
        self.closed = False

    def send(self, message: dict[str, Any]) -> None:
        self.messages.append(message)

    def close(self) -> None:
        self.closed = True

    def last(self, kind: str) -> dict[str, Any] | None:
        for message in reversed(self.messages):
            if message.get("type") == kind:
                return message
        return None

    def all(self, kind: str) -> list[dict[str, Any]]:
        return [m for m in self.messages if m.get("type") == kind]

    def clear(self) -> None:
        self.messages.clear()

    # ── ทางลัดที่ใช้บ่อย ────────────────────────────────────────────────────

    @property
    def session_token(self) -> str:
        return self.last("session")["token"]

    @property
    def seat(self) -> int:
        return self.last("match_start")["you"]

    @property
    def state(self) -> dict[str, Any]:
        return self.last("state")["state"]

    @property
    def game_view(self) -> dict[str, Any]:
        return self.state["view"]


class HubHarness:
    def __init__(self, **options: Any) -> None:
        self.scheduler = ManualScheduler()
        options.setdefault("turn_seconds", 0)
        options.setdefault("bot_step_delay", 0.0)
        options.setdefault("autopilot_grace", 5.0)
        self.hub = Hub(registry, auth_secret=SECRET, scheduler=self.scheduler, **options)

    def connect(self, name: str | None = None, token: str | None = None) -> FakeConnection:
        connection = FakeConnection()
        message: dict[str, Any] = {"type": "hello"}
        if name:
            message["name"] = name
        if token:
            message["token"] = token
        self.hub.handle(connection, message)
        return connection

    def send(self, connection: FakeConnection, message: dict[str, Any]) -> None:
        self.hub.handle(connection, message)

    def act(self, connection: FakeConnection, action: str, **payload: Any) -> None:
        self.hub.handle(connection, {"type": "action", "action": action, "payload": payload})

    def advance(self, seconds: float) -> int:
        return self.scheduler.advance(seconds)

    def run_pending(self, limit: int = 200) -> int:
        return self.scheduler.run_pending(limit)

    def play_turn(self, connection: FakeConnection) -> None:
        """เดินหนึ่งเทิร์นเต็มโดยอาศัยเป้าที่เซิร์ฟเวอร์บอกมาเท่านั้น"""
        view = connection.game_view
        for square in view["selectable"]:
            self.act(connection, "select", square=square)
            view = connection.game_view
            if view["targetKind"] == "capture":
                break
        while view["status"] == "active" and view["selection"] is not None:
            targets = view["targets"]
            if not targets:
                break
            self.act(connection, "play", to=targets[0])
            view = connection.game_view
