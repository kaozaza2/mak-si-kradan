"""ยืนยันอีเมลด้วยรหัสหกหลัก"""

import pytest_asyncio

from makthai.db.session import Database
from makthai.services.accounts import Accounts
from makthai.services.verification import MAX_ATTEMPTS, Verification


@pytest_asyncio.fixture
async def session():
    db = Database("sqlite+aiosqlite:///:memory:")
    await db.create_all()
    async with db.session() as opened:
        yield opened
    await db.dispose()


async def make_account(session, email: str = "player@example.com"):
    result = await Accounts(session).register(
        email=email, password="password1234", display_name="ผู้เล่น"
    )
    assert result.ok, result.code
    return result.user


async def test_ออกรหัสแล้วยืนยันได้(session):
    await make_account(session)
    verification = Verification(session)

    issued = await verification.issue("player@example.com")
    assert issued.ok
    assert len(issued.code) == 6 and issued.code.isdigit()

    # อีเมลตัวพิมพ์ใหญ่ก็ยังยืนยันได้ เพราะเก็บเป็นตัวพิมพ์เล็กเสมอ
    result = await verification.verify("PLAYER@example.com", issued.code)
    assert result.ok
    assert result.user.verified is True


async def test_รหัสใช้ได้ครั้งเดียว(session):
    await make_account(session)
    verification = Verification(session)
    issued = await verification.issue("player@example.com")

    assert (await verification.verify("player@example.com", issued.code)).ok
    assert (await verification.verify("player@example.com", issued.code)).code == "otp_invalid"


async def test_ขอรหัสใหม่แล้วรหัสเก่าใช้ไม่ได้(session):
    await make_account(session)
    verification = Verification(session)
    first = await verification.issue("player@example.com")
    second = await verification.issue("player@example.com")

    assert (await verification.verify("player@example.com", first.code)).code == "otp_invalid"
    assert (await verification.verify("player@example.com", second.code)).ok


async def test_กรอกผิดครบโควตาแล้วรหัสถูกทิ้ง(session):
    await make_account(session)
    verification = Verification(session)
    issued = await verification.issue("player@example.com")

    for _ in range(MAX_ATTEMPTS):
        assert (await verification.verify("player@example.com", "000000")).code == "otp_invalid"

    # ครบโควตาแล้ว ถึงกรอกถูกก็ใช้ไม่ได้ ต้องขอใหม่
    blocked = await verification.verify("player@example.com", issued.code)
    assert blocked.code == "otp_too_many_attempts"


async def test_ยืนยันแล้วขอรหัสอีกไม่ได้(session):
    await make_account(session)
    verification = Verification(session)
    issued = await verification.issue("player@example.com")
    await verification.verify("player@example.com", issued.code)

    again = await verification.issue("player@example.com")
    assert again.reason == "email_already_verified"


async def test_อีเมลที่ไม่มีบัญชีไม่ได้รหัส(session):
    assert (await Verification(session).issue("nobody@example.com")).reason == "email_not_found"


async def test_ยืนยันโดยไม่เคยขอรหัสไม่ผ่าน(session):
    await make_account(session)
    assert (
        await Verification(session).verify("player@example.com", "123456")
    ).code == "otp_invalid"


async def test_รหัสของคนหนึ่งใช้กับอีกคนไม่ได้(session):
    """แฮชผูกกับอีเมลปลายทาง"""
    await make_account(session, "a@example.com")
    await make_account(session, "b@example.com")
    verification = Verification(session)
    issued = await verification.issue("a@example.com")
    await verification.issue("b@example.com")

    assert (await verification.verify("b@example.com", issued.code)).code == "otp_invalid"


async def test_รหัสตั้งรหัสผ่านใหม่กับรหัสยืนยันอีเมลใช้แทนกันไม่ได้(session):
    """คนละเหตุคนละรหัส ไม่งั้นรหัสที่ขอมาเพื่ออย่างหนึ่งเอาไปทำอีกอย่างได้"""
    await make_account(session)
    verification = Verification(session)
    reset = await verification.issue("player@example.com", "reset_password")

    assert (await verification.verify("player@example.com", reset.code)).code == "otp_invalid"
    assert (await verification.verify("player@example.com", reset.code, "reset_password")).ok


async def test_ยืนยันแล้วยังขอรหัสตั้งรหัสผ่านใหม่ได้(session):
    """ห้ามขอซ้ำใช้กับการยืนยันอีเมลเท่านั้น คนลืมรหัสผ่านต้องขอได้เสมอ"""
    await make_account(session)
    verification = Verification(session)
    issued = await verification.issue("player@example.com")
    await verification.verify("player@example.com", issued.code)

    assert (await verification.issue("player@example.com", "reset_password")).ok


async def test_ตั้งรหัสผ่านใหม่แล้วรหัสเดิมใช้ไม่ได้(session):
    from makthai.services.accounts import Accounts

    await make_account(session)
    accounts = Accounts(session)
    assert (await accounts.set_password("player@example.com", "brand-new-password")).ok

    assert (
        await accounts.login("player@example.com", "password1234")
    ).code == "invalid_credentials"
    assert (await accounts.login("player@example.com", "brand-new-password")).ok


async def test_รหัสผ่านใหม่ที่สั้นเกินไปไม่ผ่าน(session):
    from makthai.services.accounts import Accounts

    await make_account(session)
    assert (await Accounts(session).set_password("player@example.com", "sh0rt")).code == (
        "weak_password"
    )
