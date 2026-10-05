"""การเชื่อมต่อฐานข้อมูล

ไม่ตั้ง DATABASE_URL ก็ยังเล่นได้ครบทุกอย่าง แค่ไม่มีบัญชีผู้ใช้ ไม่มีอันดับ
และไม่เก็บประวัติ การเล่นจึงไม่ควรผูกกับการมีฐานข้อมูล
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from makthai.db.models import Base


def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
    """เปิดบังคับ foreign key ของ SQLite ทุกครั้งที่ต่อใหม่

    ค่านี้เป็นต่อการเชื่อมต่อ ไม่ใช่ต่อฐานข้อมูล ถ้าไม่ตั้งทุกครั้ง connection ใหม่
    ที่ pool เปิดขึ้นมาจะกลับไปเป็นค่าเริ่มต้นคือปิดอีก
    """
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


class Database:
    def __init__(self, url: str) -> None:
        self.url = url
        # SQLite ไม่บังคับ foreign key โดยปกติ ทำให้ ondelete CASCADE / SET NULL
        # ในโมเดลไม่มีผลเลย ข้อมูลค้างเป็นตายตัว และเทสต์ที่รันบน SQLite
        # จะผ่านทั้งที่ production ที่ใช้ Postgres พัง
        # จึงต้องเปิดให้ SQLite ทำตามเหมือนกัน ไม่งั้นเทสต์จะโกหกเรา
        self.engine: AsyncEngine = create_async_engine(url, future=True)
        if _is_sqlite(url):
            event.listen(self.engine.sync_engine, "connect", _enable_sqlite_foreign_keys)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        """สร้างตารางให้ครบ — พอสำหรับ dev และเทสต์ ส่วน production ใช้ migration"""
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.session_factory() as session:
            yield session

    async def ping(self) -> None:
        """ยิงคำสั่งเบา ๆ หนึ่งครั้งเพื่อยืนยันว่ายังต่อฐานข้อมูลได้จริง

        ใช้ใน readiness probe — pool ของ SQLAlchemy อาจยังเชื่อมต่อไว้ทั้งที่
        เซิร์ฟเวอร์ฐานข้อมูลตายไปแล้ว ถ้าไม่ยิงคำสั่งจริงก็ไม่มีทางรู้
        """
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()


def create_database(url: str) -> Database | None:
    return Database(url) if url else None
