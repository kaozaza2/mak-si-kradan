"""ต่อ hub เข้ากับ WebSocket ของ FastAPI

ชั้นนี้ทำแค่รับส่งข้อความ ไม่มีตรรกะของเกมหรือของ lobby เลย

hub เป็นโค้ดแบบซิงโครนัสเพื่อให้เทสต์ขับได้ตรง ๆ ส่วนการส่งออกเป็นแบบไม่ซิงโครนัส
จึงพักข้อความไว้ในคิวแล้วมีงานเบื้องหลังคอยส่ง ทำให้ hub ไม่ต้องรอ I/O
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from makthai.realtime.hub import Hub

logger = logging.getLogger(__name__)
_ids = itertools.count()

#: กันข้อความค้างจนกินหน่วยความจำเมื่อ client อ่านไม่ทัน
OUTBOX_LIMIT = 256


class WebSocketConnection:
    def __init__(self, socket: WebSocket) -> None:
        self.id = f"ws_{next(_ids)}"
        self.session_id: str | None = None
        self.socket = socket
        self.outbox: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=OUTBOX_LIMIT)
        self.closed = False

    def send(self, message: dict[str, Any]) -> None:
        if self.closed:
            return
        try:
            self.outbox.put_nowait(message)
        except asyncio.QueueFull:
            # ตามไม่ทันแล้ว ตัดการเชื่อมต่อดีกว่าปล่อยให้บวมไปเรื่อย ๆ
            logger.warning("outbox เต็ม ตัดการเชื่อมต่อ %s", self.id)
            self.close()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib_suppress():
            self.outbox.put_nowait(None)

    async def pump(self) -> None:
        """ส่งข้อความที่ค้างอยู่ออกไปเรื่อย ๆ จนกว่าจะถูกปิด"""
        while True:
            message = await self.outbox.get()
            if message is None:
                return
            await self.socket.send_text(json.dumps(message, ensure_ascii=False))


class contextlib_suppress:
    """ตัวช่วยเล็ก ๆ แทน contextlib.suppress เพื่อให้อ่านง่ายตรงจุดใช้งาน"""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: object) -> bool:
        return True


async def serve(socket: WebSocket, hub: Hub) -> None:
    await socket.accept()
    connection = WebSocketConnection(socket)
    pump = asyncio.create_task(connection.pump())

    try:
        while True:
            raw = await socket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                connection.send({"type": "error", "code": "not_json"})
                continue
            try:
                hub.handle(connection, message)
            except Exception:
                logger.exception("จัดการข้อความไม่สำเร็จ")
                connection.send({"type": "error", "code": "server_error"})
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(connection)
        connection.close()
        pump.cancel()
