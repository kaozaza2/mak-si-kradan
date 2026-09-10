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
    #: ชื่อโหนดในคลัสเตอร์ — ไม่ตั้งก็สุ่มให้ตอนเริ่ม
    node_id: str = ""
    #: แยกวงคุยเมื่อหลายสภาพแวดล้อมใช้ Redis ตัวเดียวกัน
    cluster_prefix: str = "makthai"
    #: สร้างตารางเองตอนเริ่มแอป — สะดวกตอนพัฒนา แต่ production ควรใช้ migration
    auto_create_tables: bool = True

    #: ใช้เซ็น token ของทั้ง guest และบัญชีที่สมัคร ทุก node ต้องใช้ค่าเดียวกัน
    auth_secret: str = ""
    turn_seconds: int = 45

    #: ไม่ตั้งทั้ง smtp และ webhook = พิมพ์รหัสยืนยันลงบันทึกให้เห็นตอนพัฒนา
    mail_webhook_url: str = ""
    mail_webhook_token: str = ""
    mail_from: str = "หมากไทย <no-reply@mak-thai.local>"
    #: ตั้ง smtp_host เมื่อไหร่จะใช้ SMTP แทน webhook — กล่องจดหมายทดสอบก็ทางนี้
    smtp_host: str = ""
    smtp_port: int = 1025
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_start_tls: bool = False
    #: client id ทุกตัวที่ใช้ คั่นด้วยจุลภาค (เว็บ ไอโอเอส แอนดรอยด์)
    google_client_ids: str = ""
    #: client id ของฝั่งเว็บ ใช้เริ่ม Google Identity Services ในเบราว์เซอร์
    google_web_client_id: str = ""

    @property
    def google_client_id_list(self) -> list[str]:
        return [value.strip() for value in self.google_client_ids.split(",") if value.strip()]

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
