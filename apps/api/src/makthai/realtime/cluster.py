"""กระจายการเล่นออกหลายเครื่อง

ทางเลือกที่ไม่เอา: ยกห้องกับแมตช์ทั้งหมดไปไว้ใน Redis แล้วให้ทุกโหนดอ่านเขียนร่วมกัน
วิธีนั้นต้องแปลงสถานะเกมไปกลับทุกตาเดิน ต้องล็อกกันเอง และลาก engine ที่ตอนนี้เป็น
Python ล้วนให้ไปรู้จัก I/O ด้วย

ที่เลือกใช้: **หนึ่งห้องหนึ่งแมตช์มีเจ้าของโหนดเดียว** สถานะเกมยังอยู่ในหน่วยความจำ
ของโหนดนั้นเหมือนเดิม ไม่ต้องแปลงอะไรเลย ส่วนโหนดอื่นทำหน้าที่เป็นทางผ่าน — รับคำสั่ง
จาก WebSocket ของตัวเองแล้วส่งต่อไปให้เจ้าของ และรับข้อความที่เจ้าของส่งกลับมาแจกลง
socket ที่ถืออยู่ hub จึงแทบไม่ต้องแก้ เพราะมันคุยกับผู้เล่นผ่าน Connection อยู่แล้ว
การเชื่อมต่อข้ามเครื่องก็เป็น Connection อีกแบบหนึ่งเท่านั้น

ของที่ทุกโหนดต้องเห็นตรงกัน — รายการห้องสาธารณะ คิวจับคู่ ใครออนไลน์ — ใช้วิธีให้
แต่ละโหนดประกาศภาพรวมของตัวเองออกไป แล้วทุกโหนดเก็บสำเนาไว้อ่านเอง การอ่านจึงเป็น
งานในหน่วยความจำล้วน hub ที่เขียนเป็นซิงโครนัสอยู่แล้วจึงไม่ต้องรอ I/O กลางเกม
แลกกับการที่รายการห้องช้ากว่าความจริงเสี้ยววินาที ซึ่งเป็นราคาที่รับได้สำหรับหน้ารายการ
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: ช่อง pub/sub ของ Redis ไม่แยกตามฐานข้อมูล สองสภาพแวดล้อมที่ใช้ Redis ตัวเดียวกัน
#: จึงได้ยินเสียงกันข้ามไปมา ตั้ง CLUSTER_PREFIX ให้ต่างกันเพื่อแยกวงคุย
CHANNEL_PREFIX = "makthai"
#: ประกาศภาพรวมซ้ำเป็นระยะ เผื่อโหนดที่เพิ่งขึ้นมาพลาดรอบก่อนหน้า
SNAPSHOT_INTERVAL = 10.0
#: ไม่ได้ยินจากโหนดไหนนานกว่านี้ถือว่าตายแล้ว ลบสำเนาของมันทิ้ง
PEER_TIMEOUT = 35.0


@dataclass(slots=True)
class Snapshot:
    """ภาพรวมของโหนดหนึ่งที่โหนดอื่นต้องรู้

    ใส่เฉพาะ session ที่เป็นบัญชีผู้ใช้ในรายชื่อออนไลน์ เพราะที่เดียวที่ใช้คือสถานะ
    เพื่อน ซึ่งต้องมีบัญชีถึงจะเป็นเพื่อนกันได้ ผู้เล่นชั่วคราวจึงไม่ต้องประกาศออกไป
    ทำให้ขนาดของประกาศไม่โตตามจำนวนคนที่แค่แวะเข้ามาเล่น
    """

    node: str
    users: list[str] = field(default_factory=list)
    rooms: list[dict[str, Any]] = field(default_factory=list)
    #: รหัสห้อง → id ห้อง สำหรับเข้าห้องด้วยรหัสข้ามเครื่อง
    codes: dict[str, str] = field(default_factory=dict)
    #: เกม → คนที่รออยู่ในคิว เรียงตามคิวก่อนหลัง
    queues: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: session ที่โหนดนี้ถือห้องหรือแมตช์ให้ ใช้พาคนที่หลุดแล้วต่อเข้าอีกเครื่องกลับไปถูกที่
    homes: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    #: เวลาที่ได้ยินครั้งล่าสุด ผู้รับเป็นคนเติม ไม่ได้ส่งมากับตัวประกาศ
    heard_at: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "node": self.node,
            "users": self.users,
            "rooms": self.rooms,
            "codes": self.codes,
            "queues": self.queues,
            "homes": self.homes,
            "counts": self.counts,
        }

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> Snapshot:
        return Snapshot(
            node=str(raw.get("node", "")),
            users=list(raw.get("users") or []),
            rooms=list(raw.get("rooms") or []),
            codes=dict(raw.get("codes") or {}),
            queues=dict(raw.get("queues") or {}),
            homes=list(raw.get("homes") or []),
            counts=dict(raw.get("counts") or {}),
        )


class Cluster(Protocol):
    """ท่อคุยกันระหว่างโหนด

    แยกเป็นสัญญาเพื่อให้เทสต์ยกสองโหนดขึ้นมาในโปรเซสเดียวแล้วขับตรง ๆ ได้
    การกระจายที่ทดสอบไม่ได้คือการกระจายที่ไม่มีใครรู้ว่าพัง
    """

    node_id: str

    def publish(self, node: str, envelope: dict[str, Any]) -> None:
        """ส่งถึงโหนดเดียว — ต้องไม่บล็อก"""
        ...

    def broadcast(self, envelope: dict[str, Any]) -> None:
        """ส่งถึงทุกโหนดยกเว้นตัวเอง — ต้องไม่บล็อก"""
        ...

    def subscribe(self, handler: Any) -> None:
        """ตั้งตัวรับ ซึ่งจะถูกเรียกแบบซิงโครนัสด้วย envelope ที่เข้ามา"""
        ...

    async def start(self) -> None: ...

    async def stop(self) -> None: ...


class LocalCluster:
    """คลัสเตอร์ในโปรเซสเดียว

    ไม่ได้มีไว้ใช้จริง แต่มีไว้ให้เทสต์ยกหลายโหนดขึ้นมาต่อกันแล้วพิสูจน์ว่าการส่งต่อ
    คำสั่งข้ามเครื่องทำงานถูก โดยไม่ต้องมี Redis และไม่มีความไม่แน่นอนเรื่องเวลา
    """

    def __init__(self, node_id: str | None = None, peers: dict[str, LocalCluster] | None = None):
        self.node_id = node_id or uuid.uuid4().hex[:8]
        # ทุกโหนดถือ dict ใบเดียวกัน เข้าร่วมแล้วเห็นกันทันที
        self.peers: dict[str, LocalCluster] = peers if peers is not None else {}
        self.peers[self.node_id] = self
        self._handler: Any = None

    def join(self, node_id: str | None = None) -> LocalCluster:
        """สร้างอีกโหนดที่ต่ออยู่ในคลัสเตอร์เดียวกัน"""
        return LocalCluster(node_id, self.peers)

    def publish(self, node: str, envelope: dict[str, Any]) -> None:
        peer = self.peers.get(node)
        if peer is not None:
            peer._receive({**envelope, "from": self.node_id})

    def broadcast(self, envelope: dict[str, Any]) -> None:
        for node_id, peer in tuple(self.peers.items()):
            if node_id != self.node_id:
                peer._receive({**envelope, "from": self.node_id})

    def subscribe(self, handler: Any) -> None:
        self._handler = handler

    def _receive(self, envelope: dict[str, Any]) -> None:
        if self._handler is not None:
            self._handler(envelope)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        self.peers.pop(self.node_id, None)


class RedisCluster:
    """คุยกันผ่าน Redis pub/sub

    hub เป็นโค้ดซิงโครนัสเพื่อให้เทสต์ขับได้ตรง ๆ ส่วนการส่งออกเป็นงานไม่ซิงโครนัส
    จึงพักไว้ในคิวแล้วมีงานเบื้องหลังคอยส่ง แบบเดียวกับที่ทำกับ WebSocket
    """

    def __init__(
        self,
        url: str,
        node_id: str | None = None,
        prefix: str = CHANNEL_PREFIX,
        outbox_limit: int = 2048,
    ) -> None:
        self.url = url
        self.node_id = node_id or uuid.uuid4().hex[:8]
        self.prefix = prefix
        self.outbox: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=outbox_limit)
        self._handler: Any = None
        self._redis: Any = None
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def direct_channel(self) -> str:
        return f"{self.prefix}:node:{self.node_id}"

    @property
    def fanout_channel(self) -> str:
        return f"{self.prefix}:all"

    def publish(self, node: str, envelope: dict[str, Any]) -> None:
        self._enqueue(f"{self.prefix}:node:{node}", envelope)

    def broadcast(self, envelope: dict[str, Any]) -> None:
        self._enqueue(self.fanout_channel, envelope)

    def _enqueue(self, channel: str, envelope: dict[str, Any]) -> None:
        try:
            self.outbox.put_nowait((channel, {**envelope, "from": self.node_id}))
        except asyncio.QueueFull:
            # ทิ้งดีกว่าให้บวมไปเรื่อย ๆ ประกาศภาพรวมรอบหน้าจะซ่อมสำเนาให้เอง
            logger.warning("คิวส่งข้ามโหนดเต็ม ทิ้งข้อความไปยัง %s", channel)

    def subscribe(self, handler: Any) -> None:
        self._handler = handler

    async def start(self) -> None:
        import redis.asyncio as redis

        self._redis = redis.from_url(self.url, decode_responses=True)
        self._tasks = [asyncio.create_task(self._pump()), asyncio.create_task(self._listen())]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def _pump(self) -> None:
        while True:
            channel, envelope = await self.outbox.get()
            try:
                await self._redis.publish(channel, json.dumps(envelope, ensure_ascii=False))
            except Exception:
                logger.exception("ส่งข้อความข้ามโหนดไม่สำเร็จ")

    async def _listen(self) -> None:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(self.direct_channel, self.fanout_channel)
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                envelope = json.loads(message["data"])
            except (ValueError, TypeError):
                continue
            # ประกาศแบบกระจายวนกลับมาหาตัวเองด้วย ข้ามไป
            if not isinstance(envelope, dict) or envelope.get("from") == self.node_id:
                continue
            try:
                self._handler(envelope)
            except Exception:
                logger.exception("จัดการข้อความข้ามโหนดไม่สำเร็จ")


class RemoteConnection:
    """การเชื่อมต่อของผู้เล่นที่ socket จริงอยู่อีกเครื่อง

    หน้าตาเหมือน Connection ทุกอย่าง hub จึงส่งข้อความหาผู้เล่นคนนี้ด้วยวิธีเดียวกับ
    คนที่ต่ออยู่กับเครื่องนี้ ต่างกันแค่ปลายทางของ send
    """

    __slots__ = ("cluster", "edge", "id", "session_id")

    def __init__(self, cluster: Cluster, edge: str, session_id: str) -> None:
        self.cluster = cluster
        self.edge = edge
        self.id = f"remote_{edge}_{session_id}"
        self.session_id: str | None = session_id

    def send(self, message: dict[str, Any]) -> None:
        self.cluster.publish(
            self.edge, {"kind": "deliver", "session": self.session_id, "message": message}
        )

    def close(self) -> None:
        self.cluster.publish(self.edge, {"kind": "close", "session": self.session_id})


def create_cluster(
    redis_url: str = "", node_id: str = "", prefix: str = CHANNEL_PREFIX
) -> Cluster | None:
    """ไม่ตั้ง redis_url = ทำงานโหนดเดียว ซึ่งเป็นค่าเริ่มต้นและไม่ต้องพึ่งอะไรเลย"""
    return RedisCluster(redis_url, node_id or None, prefix) if redis_url else None


__all__ = [
    "PEER_TIMEOUT",
    "SNAPSHOT_INTERVAL",
    "Cluster",
    "LocalCluster",
    "RedisCluster",
    "RemoteConnection",
    "Snapshot",
    "create_cluster",
]
