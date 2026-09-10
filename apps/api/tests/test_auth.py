from makthai.auth import (
    Identity,
    new_guest_id,
    new_guest_name,
    resolve_secret,
    room_code,
    sanitize_name,
    sign_token,
    verify_token,
)

SECRET = "a-secret-that-is-long-enough-here"


def test_เซ็นแล้วตรวจกลับได้ตัวตนเดิม():
    token = sign_token("guest_abc123", "เก้า", "guest", SECRET)
    identity = verify_token(token, SECRET)
    assert identity == Identity(
        id="guest_abc123", name="เก้า", kind="guest", expires_at=identity.expires_at
    )


def test_แก้โทเคนแล้วตรวจไม่ผ่าน():
    token = sign_token("guest_abc123", "เก้า", "guest", SECRET)
    body, _, signature = token.rpartition(".")
    assert verify_token(f"{body}x.{signature}", SECRET) is None
    assert verify_token(f"{body}.{signature}x", SECRET) is None
    assert verify_token(token, "secret-other-but-long-enough") is None


def test_โทเคนหมดอายุใช้ไม่ได้():
    assert verify_token(sign_token("g", "n", "guest", SECRET, ttl=-1), SECRET) is None


def test_ข้อมูลที่ไม่ใช่โทเคนไม่ทำให้ระเบิด():
    for bad in (None, "", "not-a-token", "a.b", "...."):
        assert verify_token(bad, SECRET) is None


def test_ตัวตนของโหนดอื่นใช้ได้ถ้าใช้ซีเคร็ตเดียวกัน():
    """คนที่ถูกส่งไปอีกเครื่องต้องยังเป็นคนเดิม ชื่อเดิม"""
    token = sign_token("user_1", "อลิซ", "user", SECRET)
    assert verify_token(token, SECRET).name == "อลิซ"


def test_ชื่อผู้เล่นถูกตัดให้ปลอดภัยต่อการแสดงผล():
    assert sanitize_name("  เก้า  ", "fallback") == "เก้า"
    assert sanitize_name("ก" * 50, "fallback") == "ก" * 20
    assert sanitize_name("", "fallback") == "fallback"
    assert sanitize_name(None, "fallback") == "fallback"


def test_รหัสห้องอ่านง่ายไม่มีตัวที่สับสน():
    for _ in range(50):
        code = room_code()
        assert len(code) == 6
        assert not (set(code) & set("01OI"))


def test_ไม่ตั้งซีเคร็ตจะสุ่มให้พร้อมบอกว่าเป็นค่าชั่วคราว():
    secret, ephemeral = resolve_secret("")
    assert ephemeral and len(secret) >= 32
    assert resolve_secret("x" * 20) == ("x" * 20, False)
    # สั้นเกินไปก็ถือว่าไม่ได้ตั้ง
    assert resolve_secret("sh0rt")[1] is True


def test_ผู้เล่นชั่วคราวได้ไอดีและชื่อที่อ่านออก():
    assert new_guest_id().startswith("guest_")
    assert new_guest_name().startswith("Guest ")
    assert len({new_guest_id() for _ in range(20)}) == 20
