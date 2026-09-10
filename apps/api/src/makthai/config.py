"""ค่าตั้งของแอป — อ่านจาก environment ที่เดียว"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    app_name: str = "mak-thai"
    environment: str = "development"

    #: URL ที่ผู้ใช้เห็นจริง ใช้สร้างลิงก์เชิญเข้าห้อง
    public_url: str = "http://localhost:8000"
    #: origin ของ frontend ที่อนุญาตให้เรียก API ("*" = ทุก origin)
    cors_origins: str = "*"

    #: ไม่ตั้ง = ใช้ SQLite ในเครื่อง พอสำหรับ dev
    database_url: str = "sqlite+aiosqlite:///./mak-thai.db"
    #: ไม่ตั้ง = ทำงานแบบ node เดียว
    redis_url: str = ""

    #: ใช้เซ็น token ของทั้ง guest และบัญชีที่สมัคร ทุก node ต้องใช้ค่าเดียวกัน
    auth_secret: str = ""
    turn_seconds: int = 45

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
