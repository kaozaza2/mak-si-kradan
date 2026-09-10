"""ระบบเพื่อน"""

import pytest_asyncio

from makthai.db.session import Database
from makthai.services.accounts import Accounts
from makthai.services.friends import Friends


@pytest_asyncio.fixture
async def session():
    db = Database("sqlite+aiosqlite:///:memory:")
    await db.create_all()
    async with db.session() as opened:
        yield opened
    await db.dispose()


@pytest_asyncio.fixture
async def make_user(session):
    accounts = Accounts(session)

    async def create(username: str):
        result = await accounts.register(
            username=username, password="password1234", display_name=username
        )
        assert result.ok, result.code
        return result.user

    return create


async def test_ขอเป็นเพื่อน_ตอบรับ_แล้วเห็นกันทั้งสองฝั่ง(session, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    friends = Friends(session)

    request = await friends.request(alice.id, "bob")
    assert request.ok and request.status == "pending"

    bob_view = await friends.listing(bob.id)
    assert len(bob_view["incoming"]) == 1
    assert bob_view["incoming"][0]["player"]["username"] == "alice"
    assert len((await friends.listing(alice.id))["outgoing"]) == 1

    accepted = await friends.respond(bob.id, bob_view["incoming"][0]["requestId"], True)
    assert accepted.ok and accepted.status == "accepted"

    assert [f["username"] for f in (await friends.listing(alice.id))["friends"]] == ["bob"]
    assert [f["username"] for f in (await friends.listing(bob.id))["friends"]] == ["alice"]
    assert await friends.ids(alice.id) == [bob.id]


async def test_ขอสวนกันถือว่าตกลงทันที(session, make_user):
    alice = await make_user("cross_a")
    bob = await make_user("cross_b")
    friends = Friends(session)

    await friends.request(alice.id, "cross_b")
    reverse = await friends.request(bob.id, "cross_a")
    assert reverse.ok and reverse.status == "accepted"
    assert await friends.ids(alice.id) == [bob.id]


async def test_ปฏิเสธแล้วคำขอหายไปและขอใหม่ได้(session, make_user):
    alice = await make_user("dec_a")
    bob = await make_user("dec_b")
    friends = Friends(session)
    await friends.request(alice.id, "dec_b")

    incoming = (await friends.listing(bob.id))["incoming"]
    assert (await friends.respond(bob.id, incoming[0]["requestId"], False)).ok
    assert (await friends.listing(bob.id))["incoming"] == []
    assert await friends.ids(alice.id) == []

    assert (await friends.request(alice.id, "dec_b")).ok


async def test_ขอซ้ำ_ขอตัวเอง_และขอคนที่ไม่มีอยู่ถูกปฏิเสธพร้อมรหัส(session, make_user):
    alice = await make_user("dup_a")
    await make_user("dup_b")
    friends = Friends(session)

    assert (await friends.request(alice.id, "dup_a")).code == "friend_self"
    assert (await friends.request(alice.id, "ไม่มีคนนี้")).code == "player_not_found"

    await friends.request(alice.id, "dup_b")
    assert (await friends.request(alice.id, "dup_b")).code == "friend_request_pending"


async def test_เป็นเพื่อนแล้วขอซ้ำไม่ได้(session, make_user):
    alice = await make_user("f_a")
    bob = await make_user("f_b")
    friends = Friends(session)
    await friends.request(alice.id, "f_b")
    incoming = (await friends.listing(bob.id))["incoming"]
    await friends.respond(bob.id, incoming[0]["requestId"], True)

    assert (await friends.request(alice.id, "f_b")).code == "already_friends"


async def test_ตอบคำขอของคนอื่นแทนกันไม่ได้(session, make_user):
    alice = await make_user("g_a")
    bob = await make_user("g_b")
    carol = await make_user("g_c")
    friends = Friends(session)
    await friends.request(alice.id, "g_b")
    request_id = (await friends.listing(bob.id))["incoming"][0]["requestId"]

    assert (await friends.respond(carol.id, request_id, True)).code == "friend_request_gone"
    assert await friends.ids(alice.id) == []


async def test_ลบเพื่อนแล้วหายทั้งสองฝั่ง(session, make_user):
    alice = await make_user("bye_a")
    bob = await make_user("bye_b")
    friends = Friends(session)
    await friends.request(alice.id, "bye_b")
    request_id = (await friends.listing(bob.id))["incoming"][0]["requestId"]
    await friends.respond(bob.id, request_id, True)

    assert await friends.remove(alice.id, bob.id) is True
    assert (await friends.listing(bob.id))["friends"] == []
    assert await friends.remove(alice.id, bob.id) is False


async def test_ขอเป็นเพื่อนด้วยอีเมลก็ได้(session):
    accounts = Accounts(session)
    alice = (
        await accounts.register(
            email="mail_a@example.com", password="password1234", display_name="เอ"
        )
    ).user
    await accounts.register(email="mail_b@example.com", password="password1234", display_name="บี")

    result = await Friends(session).request(alice.id, "Mail_B@Example.com")
    assert result.ok
    assert result.player["name"] == "บี"
