"""ต่อ hub เข้ากับ WebSocket ของ FastAPI

ชั้นนี้ทำแค่รับส่งข้อความ ไม่มีตรรกะของเกมหรือของ lobby เลย

hub เป็นโค้ดแบบซิงโครนัสเพื่อให้เทสต์ขับได้ตรง ๆ ส่วนการส่งออกเป็นแบบไม่ซิงโครนัส
จึงพักข้อความไว้ในคิวแล้วมีงานเบื้องหลังคอยส่ง ทำให้ hub ไม่ต้องรอ I/O
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from makthai.auth import Identity, looks_like_session
from makthai.realtime.hub import MAX_MESSAGE_BYTES, WS_POLICY_VIOLATION, ConnectionGate, Hub
from makthai.services.accounts import Accounts
from makthai.services.sessions import Sessions

logger = logging.getLogger(__name__)
_ids = itertools.count()

#: กันข้อความค้างจนกินหน่วยความจำเมื่อ client อ่านไม่ทัน
OUTBOX_LIMIT = 256


class WebSocketConnection:
    def __init__(self, socket: WebSocket, peer: str = "unknown") -> None:
        self.id = f"ws_{next(_ids)}"
        self.session_id: str | None = None
        #: IP ของผู้เล่น ใช้จำกัดจำนวนการเชื่อมต่อ
        self.peer = peer
        #: ตัวตนที่ชั้น transport ตรวจแล้ว ใส่ตอนรับ hello
        #: hub อ่านจากที่นี่ ไม่ต้องค้นฐานข้อมูลเอง (hub เป็นโค้ดซิงโครนัส)
        self.identity: Any = None
        #: โทเคนที่จะส่งกลับไป เผื่อต่อใหม่ด้วยเซสชันเดิม
        self.token: str | None = None
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
        with contextlib.suppress(asyncio.QueueFull):
            self.outbox.put_nowait(None)

    async def pump(self) -> None:
        """ส่งข้อความที่ค้างอยู่ออกไปเรื่อย ๆ จนกว่าจะถูกปิด"""
        while True:
            message = await self.outbox.get()
            if message is None:
                return
            await self.socket.send_text(json.dumps(message, ensure_ascii=False))


class SessionResolver:
    """แปลงโทเคนเป็นตัวตน โดยรู้ว่าต้องไปหาฐานข้อมูลหรือไม่

    แยกไว้ตรงนี้เพราะ hub เป็นโค้ดซิงโครนัสและรอ I/O ไม่ได้
    ชั้น transport จึงเป็นที่ตรวจโทเคนที่ต้องค้นฐานข้อมูล
    """

    def __init__(self, secret: str, database: Any = None) -> None:
        self.secret = secret
        self.database = database

    async def resolve(self, token: object) -> tuple[Any, str | None]:
        """คืน (ตัวตน, โทเคนที่จะส่งกลับ)

        โทเคนที่ส่งกลับคืนโทเคนเดิมเมื่อยังใช้ได้ เพื่อไม่ให้ผู้เล่น
        ต้องเปลี่ยนโทเคนทุกครั้งที่เชื่อมต่อใหม่
        """
        if not isinstance(token, str) or not token:
            return None, None
        if not looks_like_session(token):
            # token ของผู้เล่นชั่วคราว hub ตรวจเองได้ ไม่ต้องแตะฐานข้อมูล
            return None, None
        if self.database is None:
            # ไม่มีฐานข้อมูลแปลว่าใช้เซสชันไม่ได้อยู่แล้ว
            return None, None
        async with self.database.session() as session:
            player_id = await Sessions(session).resolve(token)
            if player_id is None:
                return None, None
            user = await Accounts(session).get(player_id)
        if user is None:
            return None, None
        return Identity(id=user.id, name=user.name, kind="user", expires_at=0.0), token


async def serve(
    socket: WebSocket,
    hub: Hub,
    gate: ConnectionGate | None = None,
    resolver: SessionResolver | None = None,
) -> None:
    peer = socket.client.host if socket.client else "unknown"
    gate = gate if gate is not None else ConnectionGate()

    # ปฏิเสธตั้งแต่ก่อน accept ดีกว่ารับแล้วค่อยปิด
    # เพราะตอนนี้ยังไม่ได้กินคิวส่งอะไรของใคร และ client รู้เร็วกว่า
    if not gate.admit(peer):
        await socket.close(code=WS_POLICY_VIOLATION)
        return

    await socket.accept()
    connection = WebSocketConnection(socket, peer)
    pump = asyncio.create_task(connection.pump())
    resolver = resolver if resolver is not None else SessionResolver(hub.auth_secret)

    try:
        while True:
            raw = await socket.receive_text()
            if len(raw) > MAX_MESSAGE_BYTES:
                # ข้อความใหญ่ผิดปกติมาก ส่งต่อไปจะเป็นการกินหน่วยความจำของโหนด
                connection.send({"type": "error", "code": "message_too_large"})
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                connection.send({"type": "error", "code": "not_json"})
                continue
            if isinstance(message, dict) and message.get("type") == "hello":
                # ตรวจโทเคนที่ต้องค้นฐานข้อมูลตรงนี้ เพราะเป็นจุดเดียวที่รอ I/O ได้
                identity, token = await resolver.resolve(message.get("token"))
                connection.identity = identity
                connection.token = token
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
        gate.release(peer)
