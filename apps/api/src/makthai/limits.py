"""การนับในหน้าต่างเวลา พร้อมขอบเขตที่ไม่ทำให้หน่วยความจำโต

ใช้ร่วมกันระหว่างการจำกัดโควตาของ HTTP กับการคุมการเชื่อมต่อ WebSocket
เพราะสองทางนี้ต้องกันการยิงซ้ำเหมือนกัน แต่ต่างกันที่เก็บที่ไหนและอยู่นานแค่ไหน

ข้อที่ต้องระวังที่สุด: คีย์มักมาจากผู้เรียก ซึ่งควบคุมได้ เช่น IP หรืออีเมล
ถ้าเก็บไว้ทั้งหมดโดยไม่มีขอบเขต ใครส่งคำขอจากแหล่งใหม่ทุกครั้งก็ทำให้หน่วยความจำโต
เพราะฉะนั้นทุกตัวนับที่นี่ต้องมีทั้งการกวาดรายการที่หมดอายุ และเพดานสูงสุดเสมอ
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float:
        """เวลาปัจจุบันเป็นวินาที ต้องเดินไปข้างหน้าได้"""
        ...


class MonotonicClock:
    """นาฬิกาจริง ใช้ตอนรันจริง"""

    def now(self) -> float:
        return time.monotonic()


class WindowCounter:
    """นับจำนวนครั้งในช่วงเวลา แล้วลืมเองเมื่อหมดอายุ

    ใช้เป็นตัวจำกัดโควตาแบบหน้าต่างเลื่อน ง่ายกว่า token bucket และพอใช้กับ
    การยิงเดารหัสผ่านหรือจำกัดการเชื่อมต่อ ซึ่งไม่ต้องการความแม่นยำระดับสัสสัดส่วน
    """

    #: เมื่อจำนวนคีย์ถึงขีดนี้ ให้กวาดรายการที่หมดอายุออกก่อนเพิ่มคีย์ใหม่
    SWEEP_AT = 4096
    #: เพดานสูงสุดของคีย์ที่ยังไม่หมดอายุ ถ้าเกินนี้ให้ล้างทั้งหมด
    #: ยอมให้ถูกยิงเกินโควตาชั่วคราว แต่ไม่ยอมให้กินหน่วยความจำจนพัง
    MAX_KEYS = 65536

    def __init__(
        self,
        clock: Clock | None = None,
        *,
        sweep_at: int | None = None,
        max_keys: int | None = None,
        on_reset: Callable[[], None] | None = None,
    ) -> None:
        self._clock = clock or MonotonicClock()
        self._hits: dict[str, tuple[int, float]] = {}
        if sweep_at is not None:
            self.SWEEP_AT = sweep_at
        if max_keys is not None:
            self.MAX_KEYS = max_keys
        #: เรียกเมื่อต้องล้างทั้งหมด เพื่อให้ผู้ใช้บันทึกเหตุการณ์ได้
        self._on_reset = on_reset

    def allow(self, key: str, limit: int, window: float) -> bool:
        """คืนว่ายังอยู่ในโควตาหรือไม่ แล้วนับไว้เสมอ"""
        now = self._clock.now()
        if len(self._hits) >= self.SWEEP_AT:
            self._sweep(now)
        if len(self._hits) >= self.MAX_KEYS:
            # ทุกคีย์ยังไม่หมดอายุ แปลว่าโดนยิงจริง ไม่ใช่แค่คีย์ค้าง
            # ล้างทั้งก้อนดีกว่าปล่อยให้ dict โตไม่จำกัดจนพังตัวเซิร์ฟเวอร์
            self._hits.clear()
            if self._on_reset is not None:
                self._on_reset()
        count, reset_at = self._hits.get(key, (0, 0.0))
        if reset_at < now:
            self._hits[key] = (1, now + window)
            return True
        self._hits[key] = (count + 1, reset_at)
        return count + 1 <= limit

    def count(self, key: str) -> int:
        """จำนวนครั้งที่นับไว้ตอนนี้ — ใช้ตรวจว่ายังเหลือโควตาหรือไม่"""
        now = self._clock.now()
        hit = self._hits.get(key)
        if hit is None or hit[1] < now:
            return 0
        return hit[0]

    def reset(self, key: str) -> None:
        """ล้างโควตาของคีย์นี้ ใช้เมื่อรู้แล้วว่าคนนั้นทำถูกต้อง เช่น ล็อกอินสำเร็จ"""
        self._hits.pop(key, None)

    def _sweep(self, now: float) -> None:
        """ทิ้งรายการที่หมดอายุแล้ว คีย์ที่ยังนับอยู่ต้องเก็บไว้"""
        self._hits = {key: hit for key, hit in self._hits.items() if hit[1] >= now}

    @property
    def size(self) -> int:
        """จำนวนคีย์ที่ถืออยู่ — ใช้ในเทสต์และการวัด"""
        return len(self._hits)


__all__ = ["MAX_KEYS", "SWEEP_AT", "Clock", "MonotonicClock", "WindowCounter"]
