"""คลัสเตอร์บน Redis จริง

test_cluster.py พิสูจน์ตรรกะของการกระจายด้วย LocalCluster ซึ่งส่งข้อความถึงกันทันที
ในโปรเซสเดียว ตัวนี้พิสูจน์อีกเรื่องหนึ่ง — ว่า RedisCluster แปลงข้อความไปกลับได้จริง
สมัครสมาชิกช่องถูก และไม่วนข้อความของตัวเองกลับเข้าตัวเอง

ข้ามไปเงียบ ๆ เมื่อไม่ได้เปิด Redis ไว้ จะได้ไม่บังคับให้ทุกคนต้องรัน Docker:

    docker compose -f docker-compose.dev.yml up -d
"""

from __future__ import annotations

import asyncio

import pytest

from makthai.api.routes import RateLimiter
from makthai.realtime.cluster import RedisCluster

REDIS_URL = "redis://localhost:6379/15"
#: ช่อง pub/sub ไม่แยกตามฐานข้อมูล ถ้าไม่แยก prefix เทสต์จะได้ยินเสียงเซิร์ฟเวอร์จริง
#: ที่รันอยู่บนเครื่องเดียวกัน แล้วตกแบบงง ๆ เป็นครั้งคราว
PREFIX = "makthai-test"


def redis_running() -> bool:
    try:
        import socket

        with socket.create_connection(("localhost", 6379), timeout=1):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not redis_running(), reason="ไม่ได้เปิด Redis ไว้ — ดูคำอธิบายบนหัวไฟล์")


async def wait_for(inbox: list, count: int = 1, timeout: float = 3.0) -> None:
    """รอจนข้อความมาถึง — pub/sub ไม่ได้ถึงทันทีเหมือนในโปรเซสเดียว"""
    deadline = asyncio.get_running_loop().time() + timeout
    while len(inbox) < count:
        assert asyncio.get_running_loop().time() < deadline, f"รอไม่ถึง {count} ข้อความ: {inbox}"
        await asyncio.sleep(0.02)


@pytest.fixture
async def pair():
    a = RedisCluster(REDIS_URL, "node-a", PREFIX)
    b = RedisCluster(REDIS_URL, "node-b", PREFIX)
    await a.start()
    await b.start()
    # ให้ตัวรับสมัครสมาชิกช่องเสร็จก่อน ไม่งั้นข้อความแรกหายไปเฉย ๆ
    await asyncio.sleep(0.3)
    yield a, b
    await a.stop()
    await b.stop()


async def test_ส่งถึงโหนดเดียวถึงปลายทางที่ตั้งใจ(pair):
    a, b = pair
    inbox: list = []
    b.subscribe(inbox.append)

    a.publish("node-b", {"kind": "forward", "message": {"type": "ทดสอบ", "ค่า": 1}})

    await wait_for(inbox)
    assert inbox[0]["from"] == "node-a"
    assert inbox[0]["message"] == {"type": "ทดสอบ", "ค่า": 1}


async def test_ประกาศถึงทุกโหนดแต่ไม่วนกลับหาตัวเอง(pair):
    a, b = pair
    mine: list = []
    theirs: list = []
    a.subscribe(mine.append)
    b.subscribe(theirs.append)

    a.broadcast({"kind": "snapshot", "snapshot": {"node": "node-a"}})

    await wait_for(theirs)
    assert theirs[0]["kind"] == "snapshot"
    # ผู้ประกาศเองไม่ต้องได้ยินเสียงตัวเอง
    await asyncio.sleep(0.2)
    assert mine == []


async def test_ส่งไปหาโหนดที่ไม่มีอยู่ไม่ทำให้พัง(pair):
    a, b = pair
    inbox: list = []
    b.subscribe(inbox.append)

    a.publish("โหนดที่ไม่มีอยู่", {"kind": "forward"})
    a.publish("node-b", {"kind": "forward", "ลำดับ": 2})

    # ข้อความที่ไม่มีใครรับหายไปเฉย ๆ ส่วนข้อความถัดไปยังส่งได้ตามปกติ
    await wait_for(inbox)
    assert inbox[0]["ลำดับ"] == 2


async def test_ข้อความที่ไม่ใช่เจสัน_ไม่ทำให้ตัวรับตาย(pair):
    a, b = pair
    inbox: list = []
    b.subscribe(inbox.append)

    await a._redis.publish(b.direct_channel, "ไม่ใช่ json")
    a.publish("node-b", {"kind": "forward", "หลังขยะ": True})

    await wait_for(inbox)
    assert inbox[0]["หลังขยะ"] is True


# ── โควตาที่นับรวมกันทั้งคลัสเตอร์ ────────────────────────────────────────────


@pytest.fixture
async def limiter():
    import redis.asyncio as redis

    client = redis.from_url(REDIS_URL, decode_responses=True)
    await client.flushdb()
    await client.aclose()

    made = [RateLimiter(REDIS_URL), RateLimiter(REDIS_URL)]
    yield made
    for one in made:
        await one.close()


async def test_สองเครื่องนับโควตารวมกัน(limiter):
    """ไม่งั้นโควตาคูณตามจำนวนเครื่อง ซึ่งเท่ากับไม่ได้จำกัดอะไรเลย"""
    first, second = limiter

    assert await first.allow("login:1.2.3.4", 3, 60) is True
    assert await second.allow("login:1.2.3.4", 3, 60) is True
    assert await first.allow("login:1.2.3.4", 3, 60) is True
    # ครบสามครั้งแล้ว ไม่ว่าจะยิงเข้าเครื่องไหน
    assert await second.allow("login:1.2.3.4", 3, 60) is False


async def test_คนละกุญแจคนละโควตา(limiter):
    first, _ = limiter
    assert await first.allow("login:1.1.1.1", 1, 60) is True
    assert await first.allow("login:1.1.1.1", 1, 60) is False
    assert await first.allow("login:2.2.2.2", 1, 60) is True


async def test_redis_ล่มแล้วถอยไปนับของเครื่องตัวเอง():
    """ปล่อยผ่านทั้งหมดคือเปิดประตูให้เดารหัสผ่าน ปิดทั้งหมดคือล็อกคนใช้จริงออก"""
    offline = RateLimiter("redis://localhost:6399/0")

    assert await offline.allow("login:9.9.9.9", 2, 60) is True
    assert await offline.allow("login:9.9.9.9", 2, 60) is True
    assert await offline.allow("login:9.9.9.9", 2, 60) is False
