"""ตัวตั้งเวลา

hub ต้องตั้งเวลาหลายอย่าง — นาฬิกาเทิร์น หน่วงก่อนบอทเดิน รอคนที่หลุดกลับมา
แต่ถ้าผูกกับ asyncio ตรง ๆ เทสต์จะต้องนอนรอจริง ซึ่งช้าและไม่แน่นอน
จึงแยกเป็นสัญญาเล็ก ๆ ที่เทสต์ใส่ตัวเดินเวลาเองได้
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
import time
from collections.abc import Callable
from typing import Any, Protocol


class TimerHandle(Protocol):
    def cancel(self) -> None: ...


class Scheduler(Protocol):
    def call_later(self, delay: float, callback: Callable[[], Any]) -> TimerHandle: ...

    def now(self) -> float:
        """เวลาปัจจุบันของนาฬิกาที่ตั้งงานไว้

        ทุกอย่างที่วัดระยะเวลาต้องอ่านจากนี่ ไม่ใช่ time.monotonic() ตรง ๆ
        เพราะตอนเทสต์เวลาเดินตามที่สั่งเท่านั้น ถ้าไปอ่านนาฬิกาจริง
        เวลาที่ผ่านไปในเทสต์จะไม่ตรงกับที่ตั้งไว้ ทำให้ทดสอบเรื่องเวลาไม่ได้จริง
        """
        ...


class AsyncioScheduler:
    """ใช้ตอนรันจริง"""

    def call_later(self, delay: float, callback: Callable[[], Any]) -> TimerHandle:
        return asyncio.get_running_loop().call_later(delay, callback)

    def now(self) -> float:
        return time.monotonic()


class _ManualHandle:
    __slots__ = ("cancelled",)

    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class ManualScheduler:
    """ใช้ในเทสต์ — เวลาเดินเมื่อสั่งเท่านั้น ทำให้ผลลัพธ์เหมือนเดิมทุกครั้ง"""

    def __init__(self) -> None:
        self._now = 0.0
        self._queue: list[tuple[float, int, _ManualHandle, Callable[[], Any]]] = []
        self._counter = itertools.count()

    def call_later(self, delay: float, callback: Callable[[], Any]) -> TimerHandle:
        handle = _ManualHandle()
        heapq.heappush(
            self._queue, (self._now + max(0.0, delay), next(self._counter), handle, callback)
        )
        return handle

    def now(self) -> float:
        """เวลาตามที่เทสต์เดินให้ — เริ่มที่ศูนย์เสมอ ผลลัพธ์จึงเหมือนเดิมทุกครั้ง"""
        return self._now

    def advance(self, seconds: float) -> int:
        """เดินเวลาไปข้างหน้า แล้วเรียกทุกตัวจับเวลาที่ถึงกำหนด"""
        target = self._now + seconds
        fired = 0
        while self._queue and self._queue[0][0] <= target:
            when, _, handle, callback = heapq.heappop(self._queue)
            self._now = when
            if handle.cancelled:
                continue
            callback()
            fired += 1
        self._now = target
        return fired

    def run_pending(self, limit: int = 200) -> int:
        """เรียกงานที่ค้างอยู่ทั้งหมดโดยไม่สนเวลา — สะดวกตอนทดสอบบอท"""
        fired = 0
        while self._queue and fired < limit:
            _, _, handle, callback = heapq.heappop(self._queue)
            if handle.cancelled:
                continue
            callback()
            fired += 1
        return fired

    @property
    def pending(self) -> int:
        return sum(1 for _, _, handle, _ in self._queue if not handle.cancelled)
