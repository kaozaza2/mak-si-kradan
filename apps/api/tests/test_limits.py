"""ตัวนับในหน้าต่างเวลา

ข้อที่ต้องพิสูจน์คือมันไม่ทำให้หน่วยความจำโตไม่จำกัด เพราะคีย์มาจากผู้เรียก
ซึ่งควบคุมได้ ถ้าไม่มีขอบเขต ใครยิงจาก IP ใหม่ทุกครั้งก็ทำให้เซิร์ฟเวอร์ตาย
"""

from __future__ import annotations

from makthai.limits import WindowCounter


class FakeClock:
    """นาฬิกาที่เดินเมื่อสั่งเท่านั้น ทำให้ผลของเทสต์ไม่ขึ้นกับเวลาจริง"""

    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def counter(**options: object) -> tuple[WindowCounter, FakeClock]:
    clock = FakeClock()
    return WindowCounter(clock, **options), clock  # type: ignore[arg-type]


# ── การนับพื้นฐาน ────────────────────────────────────────────────────────────


def test_allows_up_to_limit_then_refuses() -> None:
    counter_, _clock = counter()
    allowed = [counter_.allow("k", 3, 60.0) for _ in range(5)]
    assert allowed == [True, True, True, False, False]


def test_window_resets_after_it_passes() -> None:
    counter_, clock = counter()
    assert counter_.allow("k", 1, 60.0) is True
    assert counter_.allow("k", 1, 60.0) is False

    clock.advance(61.0)
    assert counter_.allow("k", 1, 60.0) is True, "หมดอายุแล้วต้องเริ่มนับใหม่"


def test_keys_are_independent() -> None:
    counter_, _clock = counter()
    assert counter_.allow("a", 1, 60.0) is True
    assert counter_.allow("b", 1, 60.0) is True
    assert counter_.allow("a", 1, 60.0) is False
    assert counter_.allow("b", 1, 60.0) is False


def test_count_reports_current_usage() -> None:
    counter_, _clock = counter()
    assert counter_.count("k") == 0
    counter_.allow("k", 5, 60.0)
    counter_.allow("k", 5, 60.0)
    assert counter_.count("k") == 2


def test_count_is_zero_after_expiry() -> None:
    counter_, clock = counter()
    counter_.allow("k", 5, 60.0)
    clock.advance(61.0)
    assert counter_.count("k") == 0


def test_reset_clears_the_quota() -> None:
    """ล็อกอินสำเร็จแล้วต้องได้โควตาเต็ม ไม่ใช่ต้องรอหมดอายุ"""
    counter_, _clock = counter()
    for _ in range(3):
        assert counter_.allow("k", 3, 900.0) is True
    assert counter_.allow("k", 3, 900.0) is False

    counter_.reset("k")
    assert counter_.count("k") == 0
    assert counter_.allow("k", 3, 900.0) is True


def test_reset_of_unknown_key_is_harmless() -> None:
    counter_, _clock = counter()
    counter_.reset("ไม่เคยมี")
    assert counter_.size == 0


# ── ขอบเขตที่ไม่ให้หน่วยความจำโต ───────────────────────────────────────────


def test_expired_keys_are_swept_before_adding_new_ones() -> None:
    """คีย์ที่หมดอายุต้องถูกทิ้ ไม่ใช่สะสมไปเรื่อย ๆ"""
    counter_, clock = counter(sweep_at=10)
    for i in range(10):
        counter_.allow(f"old{i}", 5, 60.0)

    # ทุกคีย์หมดอายุไปแล้ว — กวาดต้องทิ้งไปทั้งสิบ เหลือแค่คีย์ที่เพิ่งเพิ่ม
    clock.advance(61.0)
    counter_.allow("new", 5, 60.0)

    assert counter_.size == 1, "ต้องเหลือแค่คีย์ใหม่ที่ยังไม่หมดอายุ"


def test_sweep_keeps_keys_that_are_still_live() -> None:
    """กวาดทิ้งแล้วคีย์ที่ยังนับอยู่ต้องอยู่ ไม่ใช่ถูกทิ้งพร้อมกัน"""
    counter_, clock = counter(sweep_at=10)
    for i in range(10):
        counter_.allow(f"live{i}", 5, 3600.0)

    counter_.allow("new", 5, 3600.0)

    assert counter_.size == 11, "คีย์ที่ยังไม่หมดอายุต้องไม่ถูกทิ้ง"


def test_size_is_capped_under_flood() -> None:
    """ยิงจาก IP ใหม่เป็นล้านคีย์ หน่วยความจำต้องไม่เกินเพดาน"""
    counter_, _clock = counter(sweep_at=64, max_keys=128)
    for i in range(20_000):
        counter_.allow(f"flood-{i}", 5, 3600.0)
        assert counter_.size <= 128


def test_flood_still_counts_so_limit_still_works() -> None:
    """หลังล้างทิ้งทั้งหมด ต้องนับใหม่และจำกัดได้จริง ไม่ใช่ปล่อยผ่าน"""
    counter_, _clock = counter(sweep_at=8, max_keys=16)
    for i in range(500):
        counter_.allow(f"flood-{i}", 1, 3600.0)

    assert counter_.allow("k", 2, 3600.0) is True
    assert counter_.allow("k", 2, 3600.0) is True
    assert counter_.allow("k", 2, 3600.0) is False


def test_reset_callback_fires_only_on_hard_reset() -> None:
    """การกวาดรายการหมดอายุเป็นเรื่องปกติ ไม่ควรถูกรายงานเป็นเหตุผิดปกติ"""
    fired: list[int] = []
    clock = FakeClock()
    counter_ = WindowCounter(clock, sweep_at=4, max_keys=64, on_reset=lambda: fired.append(1))

    for i in range(4):
        counter_.allow(f"k{i}", 5, 60.0)
    clock.advance(61.0)
    counter_.allow("fresh", 5, 60.0)
    assert fired == [], "กวาดของหมดอายุไม่ใช่การล้างทั้งหมด"

    for i in range(500):
        counter_.allow(f"new-{i}", 5, 3600.0)
    assert fired, "ต้องรายงานเมื่อถูกล้างทั้งหมดเพราะโดนยิง"


def test_sweep_threshold_can_be_configured() -> None:
    counter_, clock = counter(sweep_at=3)
    for i in range(3):
        counter_.allow(f"k{i}", 5, 60.0)
    clock.advance(61.0)
    counter_.allow("fresh", 5, 60.0)
    assert counter_.size == 1
