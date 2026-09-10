"""การเชื่อมต่อฐานข้อมูล

ไม่ตั้ง DATABASE_URL ก็ยังเล่นได้ครบทุกอย่าง แค่ไม่มีบัญชีผู้ใช้ ไม่มีอันดับ
และไม่เก็บประวัติ การเล่นจึงไม่ควรผูกกับการมีฐานข้อมูล
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from makthai.db.models import Base


class Database:
    def __init__(self, url: str) -> None:
        self.url = url
        self.engine: AsyncEngine = create_async_engine(url, future=True)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        """สร้างตารางให้ครบ — พอสำหรับ dev และเทสต์ ส่วน production ใช้ migration"""
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.session_factory() as session:
            yield session

    async def dispose(self) -> None:
        await self.engine.dispose()


def create_database(url: str) -> Database | None:
    return Database(url) if url else None
