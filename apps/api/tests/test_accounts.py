"""บัญชีผู้ใช้ อันดับ และประวัติการแข่ง"""

import pytest
import pytest_asyncio

from makthai.db.session import Database
from makthai.services.accounts import Accounts
from makthai.services.history import History, MatchOutcome, MatchRecord, SeatRecord


@pytest_asyncio.fixture
async def database():
    db = Database("sqlite+aiosqlite:///:memory:")
    await db.create_all()
    yield db
    await db.dispose()


@pytest_asyncio.fixture
async def accounts(database):
    async with database.session() as session:
        yield Accounts(session)


async def register(accounts: Accounts, email: str, name: str, verified: bool = True):
    result = await accounts.register(email=email, password="password1234", display_name=name)
    assert result.ok, result.code
    if verified:
        await accounts.mark_verified(email)
    return result.user


class TestRegistration:
    async def test_สมัครแล้วได้เรตติ้งเริ่มต้นและยังไม่ยืนยันอีเมล(self, accounts):
        result = await accounts.register(
            email="Player@Example.com", password="password1234", display_name="ผู้เล่น"
        )
        assert result.ok
        assert result.user.email == "player@example.com", "เก็บอีเมลเป็นตัวพิมพ์เล็กเสมอ"
        assert result.user.rating == 1200
        assert result.user.verified is False

    async def test_สมัครด้วยชื่อผู้ใช้ล้วนถือว่าพร้อมใช้งานเลย(self, accounts):
        """ไม่มีอีเมลก็ไม่มีอะไรให้ยืนยัน"""
        result = await accounts.register(
            username="kao", password="password1234", display_name="เก้า"
        )
        assert result.ok
        assert result.user.verified is True

    async def test_อีเมลหรือชื่อผู้ใช้ซ้ำไม่ได้(self, accounts):
        await accounts.register(email="dup@example.com", password="password1234")
        again = await accounts.register(email="DUP@example.com", password="password5678")
        assert again.code == "email_taken"

        await accounts.register(username="taken", password="password1234")
        assert (
            await accounts.register(username="Taken", password="x" * 12)
        ).code == "username_taken"

    @pytest.mark.parametrize(
        ("kwargs", "code"),
        [
            ({"email": "a@example.com", "password": "sh0rt"}, "weak_password"),
            ({"email": "a@example.com", "password": "x" * 300}, "password_too_long"),
            ({"email": "ไม่ใช่อีเมล", "password": "password1234"}, "invalid_email"),
            ({"username": "ab", "password": "password1234"}, "invalid_username"),
            ({"password": "password1234"}, "invalid_email"),
        ],
    )
    async def test_ข้อมูลที่ไม่ถูกต้องถูกปฏิเสธพร้อมรหัส(self, accounts, kwargs, code):
        assert (await accounts.register(**kwargs)).code == code

    async def test_ไม่เก็บรหัสผ่านดิบ(self, accounts):
        user = await register(accounts, "hash@example.com", "แฮช")
        assert "password1234" not in str(await accounts.get(user.id))


class TestLogin:
    async def test_ล็อกอินด้วยอีเมลหรือชื่อผู้ใช้ก็ได้(self, accounts):
        await register(accounts, "both@example.com", "ทั้งสอง")
        assert (await accounts.login("Both@Example.com", "password1234")).ok

        await accounts.register(username="byname", password="password1234")
        assert (await accounts.login("ByName", "password1234")).ok

    async def test_รหัสผิดกับไม่มีบัญชีให้รหัสเดียวกัน(self, accounts):
        """จะได้ไม่บอกใบ้ว่าอีเมลไหนมีบัญชีอยู่จริง"""
        await register(accounts, "secret@example.com", "ลับ")
        wrong = await accounts.login("secret@example.com", "wrongwrongwrong")
        missing = await accounts.login("nobody@example.com", "wrongwrongwrong")
        assert wrong.code == missing.code == "invalid_credentials"


class TestLeaderboard:
    async def test_เรียงตามเรตติ้งและนับเฉพาะคนที่เคยเล่น(self, database, accounts):
        alice = await register(accounts, "alice@example.com", "อลิซ")
        bob = await register(accounts, "bob@example.com", "บ็อบ")
        assert await accounts.leaderboard() == [], "ยังไม่มีใครเล่นก็ยังไม่มีใครติดอันดับ"

        await play_ranked_match(database, alice.id, bob.id, scores=[30, 20])
        board = await accounts.leaderboard()
        assert [row["name"] for row in board] == ["อลิซ", "บ็อบ"]
        assert board[0]["rank"] == 1
        assert board[0]["rating"] > board[1]["rating"]

    async def test_ค้นหาผู้เล่นได้ด้วยชื่อบางส่วนและไม่เจอตัวเอง(self, accounts):
        me = await register(accounts, "me@example.com", "ฉัน")
        await register(accounts, "findme1@example.com", "หาเจอหนึ่ง")
        await register(accounts, "findme2@example.com", "หาเจอสอง")

        found = await accounts.search("หาเจอ", me.id)
        assert len(found) == 2
        assert all(player["id"] != me.id for player in found)
        # สั้นเกินไปไม่ค้น กันการดึงรายชื่อทั้งระบบ
        assert await accounts.search("ห", me.id) == []


async def play_ranked_match(
    database: Database,
    *player_ids: str,
    scores: list[int],
    ranked: bool = True,
    bots: bool = False,
    match_id: str = "match_1",
) -> History:
    history = History(database)
    seats = [
        SeatRecord(
            seat=index,
            player_id=player_id,
            name=f"p{index}",
            is_bot=bots and index > 0,
            bot_level="easy" if bots and index > 0 else None,
        )
        for index, player_id in enumerate(player_ids)
    ]
    await history.start_match(
        MatchRecord(
            id=match_id,
            game_id="mak-si-kradan",
            source="quick",
            mode="assisted",
            turn_seconds=45,
            ranked=ranked,
            seats=seats,
        )
    )
    await history.record_turns(
        match_id, [{"turn": 1, "player": 0, "captures": 1}, {"turn": 2, "player": 1, "captures": 0}]
    )
    winners = [index for index, score in enumerate(scores) if score == max(scores)]
    await history.finish_match(
        match_id,
        MatchOutcome(reason="agreement", scores=scores, winners=winners, retired=[], turns=2),
    )
    return history


class TestRanking:
    async def test_แมตช์ที่ทุกที่นั่งเป็นบัญชียืนยันแล้วถูกนับอันดับ(self, database, accounts):
        alice = await register(accounts, "r1@example.com", "เอ")
        bob = await register(accounts, "r2@example.com", "บี")

        await play_ranked_match(database, alice.id, bob.id, scores=[30, 20])
        winner = await accounts.get(alice.id)
        loser = await accounts.get(bob.id)
        assert winner.rating == 1216
        assert loser.rating == 1184
        assert winner.wins == 1 and loser.losses == 1
        assert winner.games_played == 1

    async def test_แมตช์ที่มีบอทไม่นับอันดับ(self, database, accounts):
        human = await register(accounts, "vsbot@example.com", "คน")
        await play_ranked_match(database, human.id, "bot_1", scores=[40, 10], bots=True)
        assert (await accounts.get(human.id)).games_played == 0

    async def test_บัญชีที่ยังไม่ยืนยันอีเมลไม่นับอันดับ(self, database, accounts):
        a = await register(accounts, "unv1@example.com", "ยังไม่ยืนยัน", verified=False)
        b = await register(accounts, "unv2@example.com", "ยังไม่ยืนยันสอง", verified=False)
        await play_ranked_match(database, a.id, b.id, scores=[30, 10])
        assert (await accounts.get(a.id)).games_played == 0

    async def test_ห้องที่ตั้งค่าเองไม่นับอันดับ(self, database, accounts):
        a = await register(accounts, "c1@example.com", "เอ")
        b = await register(accounts, "c2@example.com", "บี")
        await play_ranked_match(database, a.id, b.id, scores=[30, 10], ranked=False)
        assert (await accounts.get(a.id)).games_played == 0


class TestMatchHistory:
    async def test_เก็บประวัติพร้อมการเดินทุกเทิร์น(self, database, accounts):
        alice = await register(accounts, "h1@example.com", "เอ")
        bob = await register(accounts, "h2@example.com", "บี")
        history = await play_ranked_match(database, alice.id, bob.id, scores=[27, 23])

        matches = await history.recent_matches(alice.id)
        assert len(matches) == 1
        match = matches[0]
        assert match["reason"] == "agreement"
        assert match["turns"] == 2
        assert match["ranked"] is True
        assert [seat["score"] for seat in match["players"]] == [27, 23]
        assert match["players"][0]["winner"] is True
        assert match["players"][0]["ratingAfter"] > match["players"][0]["ratingBefore"]

    async def test_บอทไม่มีประวัติของตัวเอง(self, database, accounts):
        human = await register(accounts, "h3@example.com", "คน")
        history = await play_ranked_match(database, human.id, "bot_x", scores=[10, 5], bots=True)
        assert await history.recent_matches("bot_x") == []
        assert len(await history.recent_matches(human.id)) == 1
