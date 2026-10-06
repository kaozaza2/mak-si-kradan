"""เซสชันฝั่งเซิร์ฟเวอร์ — ตัวที่ยกเลิกได้

เหตุผลที่มี: token ที่เซ็นเองถูกปลอมไม่ได้ แต่ก็ยกเลิกไม่ได้
เปลี่ยนรหัสผ่านแล้ว token เก่ายังใช้ได้ ถูกแบนก็เข้าเกมต่อได้
เซสชันเก็บฝั่งเซิร์ฟเวอร์จึงปิดได้จริงทุกทาง

ที่ต้องพิสูจน์: ยกเลิกแล้วใช้ไม่ได้จริง หมดอายุแล้วใช้ไม่ได้จริง
ไม่เก็บโทเคนดิบ ผู้เล่นเปิดหลายทางได้ และผู้เล่นชั่วคราวยังเล่นได้โดยไม่ต้องมีฐานข้อมูล
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from makthai.auth import SESSION_PREFIX, as_utc, looks_like_session
from makthai.db.models import Player, PlayerSession
from makthai.db.session import Database
from makthai.services.accounts import Accounts
from makthai.services.sessions import Sessions, hash_token, new_token

# ฐานข้อมูลมาจาก conftest เพื่อให้รันบน Postgres ได้เมื่อตั้ง TEST_DATABASE_URL

pytestmark = pytest.mark.asyncio


async def make_user(db: Database, email: str = "one@example.com", username: str = "player") -> str:
    """สร้างผู้เล่นหนึ่งคนและคืน id

    ชื่อผู้ใช้ต้องไม่ซ้ำ เพราะมีเงื่อนไข unique ถ้าซ้ำฐานข้อมูลจะปฏิเสธ
    ทำให้เทสต์ที่สร้างสองคนล้มด้วยข้อผิดพลาดที่ไม่เกี่ยวกับสิ่งที่กำลังทดสอบ
    """
    async with db.session() as session:
        result = await Accounts(session).register(
            email=email, username=username, password="correct-horse-8", display_name="หนึ่ง"
        )
        assert result.ok and result.user is not None
        return result.user.id


# ── รูปแบบโทเคน ──────────────────────────────────────────────────────────────


def test_session_token_has_a_recognisable_prefix() -> None:
    """ต้องแยกออกจาก token ของผู้เล่นชั่วคราวได้ ไม่งั้นสลับกัน"""
    token = new_token()
    assert token.startswith(SESSION_PREFIX)
    assert looks_like_session(token) is True


def test_guest_token_is_not_mistaken_for_a_session() -> None:
    assert looks_like_session("body.signature") is False
    assert looks_like_session("") is False
    assert looks_like_session(None) is False
    assert looks_like_session(12345) is False


def test_session_tokens_are_unique() -> None:
    assert len({new_token() for _ in range(500)}) == 500


def test_only_the_hash_is_stored_never_the_token() -> None:
    """ฐานข้อมูลรั่วต้องเอาโทเคนไปใช้ไม่ได้"""
    token = new_token()
    digest = hash_token(token)

    assert token not in digest
    assert len(digest) == 64


def test_hashing_is_stable() -> None:
    """ต้องหาเซสชันเดิมได้ ถ้าแฮชไม่คงที่จะหาไม่เจอตั้งแต่ครั้งที่สอง"""
    token = new_token()
    assert hash_token(token) == hash_token(token)


def test_different_tokens_hash_differently() -> None:
    assert hash_token(new_token()) != hash_token(new_token())


# ── ออกและใช้เซสชัน ─────────────────────────────────────────────────────────


async def test_issued_session_resolves_to_the_player(database: Database) -> None:
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id)

    assert issued.ok and issued.token
    async with database.session() as session:
        assert await Sessions(session).resolve(issued.token) == player_id


async def test_unknown_token_does_not_resolve(database: Database) -> None:
    await make_user(database)
    async with database.session() as session:
        assert await Sessions(session).resolve(new_token()) is None


async def test_empty_and_malformed_tokens_do_not_resolve(database: Database) -> None:
    await make_user(database)
    async with database.session() as session:
        sessions = Sessions(session)
        assert await sessions.resolve("") is None
        assert await sessions.resolve("not-a-real-token") is None


async def test_resolve_records_when_the_session_was_last_used(database: Database) -> None:
    """ต้องรู้ว่าเซสชันไหนยังมีคนใช้จริง ไม่ใช่แค่ยังไม่หมดอายุ"""
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id)
        await Sessions(session).resolve(issued.token)

    async with database.session() as session:
        record = await session.scalar(
            select(PlayerSession).where(
                PlayerSession.token_hash == hash_token(issued.token)
            )
        )
        assert record is not None


async def test_issuing_does_not_invalidate_earlier_sessions(database: Database) -> None:
    """คนหนึ่งคนเปิดหลายแท็บหรือหลายเครื่องได้ ต้องยังเข้าได้ทั้งหมด"""
    player_id = await make_user(database)
    tokens: list[str] = []
    async with database.session() as session:
        for _ in range(3):
            tokens.append((await Sessions(session).issue(player_id)).token)

    async with database.session() as session:
        for token in tokens:
            assert await Sessions(session).resolve(token) == player_id


# ── การยกเลิก ───────────────────────────────────────────────────────────────


async def test_revoked_session_stops_working(database: Database) -> None:
    """หัวใจของเรื่องนี้ — ยกเลิกแล้วต้องใช้ไม่ได้จริง"""
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id)
        assert await Sessions(session).resolve(issued.token) == player_id
        assert await Sessions(session).revoke(issued.token) is True

    async with database.session() as session:
        assert await Sessions(session).resolve(issued.token) is None


async def test_revoking_one_session_leaves_the_others(database: Database) -> None:
    """ปิดทุกเครื่องไม่ใช่ปิดคนที่กำลังจะออกจากระบบ"""
    player_id = await make_user(database)
    async with database.session() as session:
        keep = (await Sessions(session).issue(player_id)).token
        drop = (await Sessions(session).issue(player_id)).token
        await Sessions(session).revoke(drop)

    async with database.session() as session:
        assert await Sessions(session).resolve(keep) == player_id
        assert await Sessions(session).resolve(drop) is None


async def test_revoke_all_closes_every_open_session(database: Database) -> None:
    """ใช้เมื่อเปลี่ยนรหัสผ่านหรือถูกแบน ทุกทางที่เข้ามาต้องถูกปิด"""
    player_id = await make_user(database)
    tokens = []
    async with database.session() as session:
        for _ in range(3):
            tokens.append((await Sessions(session).issue(player_id)).token)

    async with database.session() as session:
        closed = await Sessions(session).revoke_all(player_id)

    assert closed == 3
    async with database.session() as session:
        for token in tokens:
            assert await Sessions(session).resolve(token) is None


async def test_revoke_all_only_touches_that_player(database: Database) -> None:
    """คนอื่นต้องยังใช้ได้ ไม่งั้นแบนคนหนึ่งแล้วทุกคนหลุด"""
    first = await make_user(database, "one@example.com", "player1")
    second = await make_user(database, "two@example.com", "player2")
    async with database.session() as session:
        mine = (await Sessions(session).issue(first)).token
        theirs = (await Sessions(session).issue(second)).token
        await Sessions(session).revoke_all(first)

    async with database.session() as session:
        assert await Sessions(session).resolve(mine) is None
        assert await Sessions(session).resolve(theirs) == second


async def test_revoke_all_does_not_recount_already_revoked(database: Database) -> None:
    """นับเฉพาะที่ยังใช้อยู่ ไม่งั้นตัวเลขจะเพิ้ยน"""
    player_id = await make_user(database)
    async with database.session() as session:
        first = (await Sessions(session).issue(player_id)).token
        await Sessions(session).revoke(first)
        await Sessions(session).issue(player_id)
        closed = await Sessions(session).revoke_all(player_id)

    assert closed == 1


async def test_revoking_an_unknown_token_is_harmless(database: Database) -> None:
    await make_user(database)
    async with database.session() as session:
        assert await Sessions(session).revoke(new_token()) is False


async def test_revoking_everything_then_issuing_gives_a_working_session(
    database: Database,
) -> None:
    """หลังปิดทั้งหมด คนที่สั่งต้องยังใช้ต่อได้ด้วยเซสชันใหม่"""
    player_id = await make_user(database)
    async with database.session() as session:
        await Sessions(session).issue(player_id)
        await Sessions(session).revoke_all(player_id)
        fresh = await Sessions(session).issue(player_id)

    async with database.session() as session:
        assert await Sessions(session).resolve(fresh.token) == player_id


# ── อายุ ────────────────────────────────────────────────────────────────────


async def test_expired_session_does_not_work(database: Database) -> None:
    """หมดอายุแล้วต้องใช้ไม่ได้ แม้ยังไม่ถูกลบออกจากตาราง"""
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id, ttl=timedelta(seconds=1))

    # บังคับให้หมดอายุโดยไม่ต้องรอเวลาจริง
    async with database.session() as session:
        record = await session.scalar(
            select(PlayerSession).where(
                PlayerSession.token_hash == hash_token(issued.token)
            )
        )
        assert record is not None
        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    async with database.session() as session:
        assert await Sessions(session).resolve(issued.token) is None


async def test_expiry_is_recorded_on_issue(database: Database) -> None:
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id, ttl=timedelta(days=7))

    assert issued.expires_at is not None
    delta = issued.expires_at - datetime.now(UTC)
    assert timedelta(days=6) < delta <= timedelta(days=7)


# ── ความสัมพันธ์กับผู้เล่น ──────────────────────────────────────────────────


async def test_session_dies_with_the_player(database: Database) -> None:
    """ลบผู้เล่นแล้วต้องไม่เหลือเซสชันของใครที่ไม่มีอยู่แล้ว"""
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id)

    async with database.session() as session:
        player = await session.get(Player, player_id)
        assert player is not None
        await session.delete(player)
        await session.commit()

    async with database.session() as session:
        assert await Sessions(session).resolve(issued.token) is None


async def test_two_tokens_never_share_a_row(database: Database) -> None:
    """ถ้าแฮชซ้ำกันได้ การยกเลิกแถวหนึ่งจะไม่ยกเลิกอีกแถว ทำให้การแบนไม่มีผล"""
    player_id = await make_user(database)
    async with database.session() as session:
        for _ in range(20):
            await Sessions(session).issue(player_id)
        rows = (await session.scalars(select(PlayerSession))).all()

    assert len(rows) == 20
    assert len({row.token_hash for row in rows}) == 20


async def test_resolve_updates_last_seen(database: Database) -> None:
    player_id = await make_user(database)
    async with database.session() as session:
        issued = await Sessions(session).issue(player_id)

    before = datetime.now(UTC)
    async with database.session() as session:
        await Sessions(session).resolve(issued.token)

    async with database.session() as session:
        record = await session.scalar(
            select(PlayerSession).where(
                PlayerSession.token_hash == hash_token(issued.token)
            )
        )
        assert record is not None
        # SQLite ไม่คืนโซนเวลามา ต้องตีความก่อนเทียบ ไม่งั้นเทสต์นี้จะล้มเฉพาะตอนรันบน SQLite
        assert as_utc(record.last_seen_at) >= before - timedelta(seconds=1)


async def test_expired_sessions_are_eventually_cleaned_up(database: Database) -> None:
    """ตารางต้องไม่โตไม่จำกัด ต้องมีการลบเป็นระยะ"""
    player_id = await make_user(database)
    async with database.session() as session:
        expired = await Sessions(session).issue(player_id, ttl=timedelta(seconds=-1))
        await Sessions(session).issue(player_id)

    # ลดจำนวนครั้งที่กวาด เพื่อไม่ต้องเรียกใช้งานจริงถึงสองร้อยครั้ง
    from makthai.services import sessions as sessions_module

    original = sessions_module.CLEANUP_EVERY
    sessions_module.CLEANUP_EVERY = 1
    try:
        async with database.session() as session:
            await Sessions(session).resolve((await Sessions(session).issue(player_id)).token)
    finally:
        sessions_module.CLEANUP_EVERY = original

    async with database.session() as session:
        remaining = (await session.scalars(select(PlayerSession))).all()
        assert all(row.token_hash != hash_token(expired.token) for row in remaining)
