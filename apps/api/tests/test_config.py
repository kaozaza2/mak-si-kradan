"""การตั้งค่าตอนเริ่มแอป

ค่าเริ่มต้นทุกข้อเหมาะกับ dev บนเครื่อง แต่ไม่ปลอดภัยเมื่อเปิดสู่ภายนอก
การตรวจตอนเริ่มทำให้ deploy ที่พลาดตัวแปรหยุดพร้อมคำอธิบาย
"""

from __future__ import annotations

import pytest

from makthai.config import MIN_AUTH_SECRET, Settings


def prod(**overrides: object) -> Settings:
    """ค่าของ production ที่ตั้งครบทุกอย่าง แล้วผ่อนกันได้"""
    base: dict[str, object] = {
        "environment": "production",
        "auth_secret": "s" * MIN_AUTH_SECRET,
        "cors_origins": "https://mak-thai.example",
        "auto_create_tables": False,
        "database_url": "postgresql+asyncpg://app:secret@db/makthai",
        "public_url": "https://mak-thai.example",
        "smtp_host": "smtp.example",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def test_dev_defaults_are_always_accepted() -> None:
    """ค่าเริ่มต้นเปล่า ๆ ต้องใช้ได้ตอนพัฒนา ไม่งั้นจะพัฒนาต่อไม่ได้"""
    assert Settings().production_problems() == []


def test_complete_production_config_passes() -> None:
    assert prod().production_problems() == []


def test_missing_auth_secret_is_rejected() -> None:
    assert prod(auth_secret="").production_problems()


def test_short_auth_secret_is_rejected() -> None:
    """สั้นเกินกำหนด = เดาง่าย และมักเกิดจากการเผลอตั้งค่าสั้น ๆ"""
    assert prod(auth_secret="short").production_problems()


def test_wildcard_cors_is_rejected() -> None:
    assert prod(cors_origins="*").production_problems()


def test_auto_create_tables_is_rejected() -> None:
    """create_all ไม่แก้ตารางที่มีอยู่แล้ว ของเก่าจะพังเงียบตอนรันจริง"""
    assert prod(auto_create_tables=True).production_problems()


def test_missing_database_is_rejected() -> None:
    assert prod(database_url="").production_problems()


def test_http_public_url_is_rejected() -> None:
    """ลิงก์เชิญพาโทเคนไปหาเพื่อน ถ้าไม่เข้ารหัสคนอื่นแอบดูได้"""
    assert prod(public_url="http://mak-thai.example").production_problems()


def test_missing_mailer_is_rejected() -> None:
    """ไม่ตั้งช่องทางส่งอีเมล = รหัสยืนยันไปอยู่ในบันทึกแทนที่จะถึงผู้ใช้"""
    settings = prod(smtp_host="")
    assert settings.production_problems()


def test_webhook_also_counts_as_mailer() -> None:
    assert prod(smtp_host="", mail_webhook_url="https://hooks.example").production_problems() == []


def test_get_settings_raises_on_incomplete_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """ต้องหยุดตอนเริ่ม ไม่ใช่ปล่อยให้รันแล้วพังตอนมีคนมาใช้"""
    from makthai import config as config_module

    monkeypatch.setattr(config_module, "get_settings", config_module.get_settings)
    config_module.get_settings.cache_clear()
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("AUTH_SECRET", "")
    monkeypatch.setenv("CORS_ORIGINS", "*")

    with pytest.raises(RuntimeError) as raised:
        config_module.get_settings()

    message = str(raised.value)
    assert "AUTH_SECRET" in message
    assert "CORS_ORIGINS" in message
    config_module.get_settings.cache_clear()


def test_every_problem_is_reported_at_once() -> None:
    """ต้องบอกทั้งหมดในครั้งเดียว ไม่ใช่ทีละข้อ ไม่งั้นต้องแก้ทีละรอบ restart"""
    settings = Settings(
        environment="production",
        auth_secret="",
        cors_origins="*",
        auto_create_tables=True,
        database_url="",
        public_url="http://x.example",
        smtp_host="",
    )
    problems = settings.production_problems()
    assert len(problems) >= 5


def test_environment_matching_is_case_insensitive() -> None:
    assert prod(environment="Production").production_problems() == []
    assert prod(environment="PRODUCTION").production_problems() == []
