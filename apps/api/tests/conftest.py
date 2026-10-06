from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

import pytest_asyncio

from makthai.games.mak_si_kradan import (
    RULE_PRESETS,
    Board,
    Game,
    GameState,
    RuleMode,
    create_game_state,
    index_of,
)

if TYPE_CHECKING:
    from makthai.db.session import Database

EMPTY_ROW = "........"


def base_test_database_url() -> str:
    """URL ฐานข้อมูลที่เทสต์ควรใช้ โดยยังไม่แยกตาราง

    ถ้าตั้ง TEST_DATABASE_URL ไว้ ให้ใช้ตัวนั้น — มักเป็น Postgres จริงใน CI
    เพราะ SQLite ไม่บังคับ foreign key และไม่มีข้อผิดพลาดพร้อมกันแบบ Postgres
    ถ้าไม่ตั้ง ถึงใช้ SQLite ในหน่วยความจำซึ่งเร็วและไม่ต้องมีบริการภายนอก
    """
    return os.environ.get("TEST_DATABASE_URL", "") or "sqlite+aiosqlite:///:memory:"


def is_shared_database(url: str) -> bool:
    """ฐานข้อมูลนี้ใช้ร่วมกับเทสต์ตัวอื่นหรือไม่

    ต้องแยกตารางให้แต่ละเทสต์เมื่อใช้ฐานข้อมูลกลาง ไม่งั้นข้อมูลที่เทสต์ก่อนหน้า
    จะยังอยู่ แล้วเทสต์ถัดไปจะเจอข้อมูลของเทสต์ก่อนหน้า
    ซึ่งทำให้เทสต์ที่ควรผ่านกลับล้ม และทำให้ล้มแบบไม่ประเสริฐ
    """
    return not url.startswith("sqlite")


async def open_test_database() -> AsyncIterator[Database]:
    """เปิดฐานข้อมูลสำหรับเทสต์แล้วปิดและล้างเมื่อเสร็จ

    นำเข้า Database ตรงนี้ไม่ได้เพราะ conftest ถูกโหลดก่อนทุกเทสต์
    รวมถึงเทสต์กติกาเกมที่ไม่ต้องใช้ฐานข้อมูลเลย
    การนำเข้าตรง ๆ จะทำให้เครื่องที่ยังไม่ได้ติดตั้ง sqlalchemy รันเทสต์เหล่านั้นไม่ได้
    """
    from makthai.db.session import Database

    url = base_test_database_url()
    schema = ""
    if is_shared_database(url):
        # แยกตารางให้แต่ละเทสต์ แล้วลบทิ้งเมื่อจบ
        # Postgres สร้าง schema แยกได้รวดเร็วกว่าสร้างฐานข้อมูลใหม่มาก
        schema = f"test_{uuid.uuid4().hex[:12]}"
        url = f"{url}?options=-csearch_path%3D{schema}"

    db = Database(url)
    # ใช้ create_all เพราะเทสต์ไม่ต้องพิสูจน์ว่า migration ถูกต้อง
    # การตรวจเรื่องนั้นเป็นหน้าที่ของ alembic check ใน CI
    await db.create_all()
    yield db
    await _drop_schema(db, schema)
    await db.dispose()


async def _drop_schema(db: Database, schema: str) -> None:
    """ลบ schema ของเทสต์ทิ้ง เพื่อไม่ให้ตารางค้างรอบหลัง"""
    if not schema:
        return
    from sqlalchemy import text

    try:
        async with db.engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
    except Exception:
        # ล้มเหลวตอนล้างไม่ควรทำให้เทสต์ที่ผ่านแล้วกลายเป็นล้ม
        # ข้อมูลที่ค้างอยู่ไม่กระทบรอบถัดไป เพราะใช้ชื่อ schema สุ่มใหม่ทุกครั้ง
        pass


#: fixture ที่เทสต์ที่ต้องการฐานข้อมูลใช้ร่วมกัน
#: ประกาศแบบนี้เพราะ pytest_asyncio ต้องเห็นตัว fixture ตอนนำเข้าไฟล์
#: แต่ Database นำเข้าตรง ๆ ไม่ได้ เพราะจะทำให้เทสต์กติกาเกมที่ไม่ใช้ฐานข้อมูล
#: รันไม่ได้บนเครื่องที่ยังไม่ได้ติดตั้ง sqlalchemy
database = pytest_asyncio.fixture(open_test_database)


def board_from_ascii(rows: list[str]) -> Board:
    """สร้างกระดานจากภาพ ASCII — 'o' คือหมาก '.' คือช่องว่าง"""
    assert len(rows) == 8, "ต้องมี 8 แถว"
    board: Board = [None] * 64
    piece_id = 0
    for r, row in enumerate(rows):
        assert len(row) == 8, f"แถว {r} ต้องมี 8 ช่อง"
        for c, symbol in enumerate(row):
            if symbol == "o":
                board[index_of(r, c)] = piece_id
                piece_id += 1
    return board


def game_with(rows: list[str], mode: RuleMode = RuleMode.ASSISTED, players: int = 2) -> Game:
    state: GameState = create_game_state(players, rules=RULE_PRESETS[mode])
    state.board = board_from_ascii(rows)
    return Game(state)
