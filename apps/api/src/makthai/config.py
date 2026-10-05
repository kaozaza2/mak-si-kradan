"""ค่าตั้งของแอป — อ่านจาก environment ที่เดียว"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

from makthai.auth import MIN_AUTH_SECRET


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

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() == "production"

    def production_problems(self) -> list[str]:
        """ค่าที่ขาดหรือไม่ปลอดภัยเมื่อรันเป็น production

        ค่าเริ่มต้นของทุกข้อเหมาะกับการพัฒนาบนเครื่อง แต่ไม่ปลอดภัยเมื่อเปิดสู่ภายนอก
        การตรวจตอนเริ่มทำให้ deploy ที่พลาดตัวแปรหยุดพร้อมคำอธิบาย
        แทนที่จะขึ้นมากว้างแล้วค่อยรู้ตอนมีคนมาใช้
        """
        if not self.is_production:
            return []
        problems: list[str] = []

        if len(self.auth_secret) < MIN_AUTH_SECRET:
            problems.append(
                f"AUTH_SECRET ต้องยาวอย่างน้อย {MIN_AUTH_SECRET} ตัวอักษร "
                "(ถ้าไม่ตั้ง ทุก node จะสุ่มคนละค่า และผู้เล่นหลุดตัวตนทุกครั้งที่รีสตาร์ต)"
            )
        if self.cors_origins.strip() == "*":
            problems.append("CORS_ORIGINS ห้ามเป็น * ใน production ต้องระบุ origin ที่อนุญาตจริง")
        if self.auto_create_tables:
            problems.append(
                "AUTO_CREATE_TABLES ต้องเป็น false ใน production "
                "เพราะ create_all ไม่แก้ตารางที่มีอยู่แล้ว ต้องใช้ alembic upgrade head"
            )
        if not self.database_url:
            problems.append(
                "DATABASE_URL ต้องตั้งใน production ไม่ตั้งจะไม่มีบัญชีผู้ใช้และไม่มีอันดับ"
            )
        if not self.public_url.startswith("https://"):
            problems.append(
                "PUBLIC_URL ต้องเป็น https:// ใน production เพราะลิงก์เชิญจะส่งผ่านทางที่ไม่เข้ารหัส"
            )
        if not self.mail_webhook_url and not self.smtp_host:
            problems.append(
                "ต้องตั้ง SMTP_HOST หรือ MAIL_WEBHOOK_URL ใน production "
                "ไม่งั้นรหัสยืนยันจะถูกพิมพ์ลงบันทึกแทนที่จะส่งถึงผู้ใช้"
            )
        return problems


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    problems = settings.production_problems()
    if problems:
        # ล้มเหลวตอนเริ่ม ไม่ใช่ปล่อยให้รันแล้วพังเงียบตอนมีคนมาใช้
        # การรันแบบค่าเริ่มต้นของ dev ยังทำได้ เพราะ ENVIRONMENT ไม่ใช่ production
        raise RuntimeError(
            "ตั้งค่าไม่ครบสำหรับ production:\n  - " + "\n  - ".join(problems)
        )
    return settings
