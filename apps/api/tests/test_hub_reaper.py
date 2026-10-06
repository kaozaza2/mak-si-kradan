"""ตัวเก็บกวาดของ hub — สิ่งที่ไม่มีใครใช้แล้วต้องไม่กินหน่วยความจำไปตลอดชีวิตโหนด

ทั้ง session และ match อยู่ในหน่วยความจำ ไม่มีการล้างเอง ถ้าไม่มีที่นี้ โหนดที่รันนาน ๆ
จะโตตามจำนวนผู้เล่นที่ผ่านมาทั้งหมด ไม่ใช่ตามคนที่กำลังออนไลน์
"""

from __future__ import annotations

import pytest

from hub_harness import FakeConnection, HubHarness


async def _start(hub: HubHarness) -> None:
    """เริ่ม hub — ต้อง await เพราะ start เป็น coroutine"""
    await hub.hub.start()


def _finish_match(hub: HubHarness, a: FakeConnection, b: FakeConnection) -> str:
    """เล่นจนจบด้วยการยอมแพ้ทั้งคู่ แล้วคืนรหัสแมตช์"""
    hub.send(a, {"type": "resign"})
    hub.run_pending()
    hub.send(b, {"type": "resign"})
    hub.run_pending()
    return str(a.state["matchId"])


@pytest.mark.asyncio
async def test_idle_guest_session_is_forgotten_after_ttl() -> None:
    """ผู้เล่นชั่วคราวที่หลุดแล้วไม่กลับมา ต้องถูกลืมเมื่อครบเวลา"""
    hub = HubHarness(session_ttl=60.0, reap_interval=10.0)
    await _start(hub)
    connection = hub.connect("Ghost")
    session_id = connection.session_id
    assert session_id in hub.hub.sessions

    hub.hub.disconnect(connection)

    # ยังไม่ถึงเวลา — ต้องยังอยู่ เพราะกำลังจะกลับมาได้
    hub.advance(30.0)
    assert session_id in hub.hub.sessions

    # ผ่านเวลาแล้ว และมีรอบเก็บกวาดวิ่งผ่าน
    hub.advance(60.0)
    assert session_id not in hub.hub.sessions


@pytest.mark.asyncio
async def test_recent_session_survives_reaper() -> None:
    """ผู้เล่นที่เพิ่งหลุดยังต้องกลับมาได้ ตัวเก็บกวาดต้องไม่ลือเร็วเกินไป"""
    hub = HubHarness(session_ttl=300.0, reap_interval=10.0)
    await _start(hub)
    connection = hub.connect("Back soon")
    session_id = connection.session_id
    hub.hub.disconnect(connection)

    hub.advance(100.0)
    assert session_id in hub.hub.sessions, "กลับมาทันยังต้องได้เกมเดิม"


@pytest.mark.asyncio
async def test_connected_session_is_never_reaped() -> None:
    """คนที่ยังออนไลน์อยู่ห้ามถูกลืมเด็ดขาด ไม่ว่ารอบเก็บกวาดจะวิ่งกี่ครั้ง"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    connection = hub.connect("Online")
    session_id = connection.session_id

    hub.advance(600.0)
    assert session_id in hub.hub.sessions


@pytest.mark.asyncio
async def test_session_in_room_is_never_reaped() -> None:
    """คนที่ยังนั่งในห้องรอเล่นอยู่ต้องไม่ถูกลืม แม้ยืนนิ่งนานมาก

    คนที่หลุดออกจากห้องแล้วถูกพาไปออกจากห้องพร้อมกัน จึงเหลือเฉพาะคนที่ยังต่ออยู่เท่านั้น
    """
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    host = hub.connect("Host")
    hub.send(host, {"type": "create_room"})
    code = host.last("room")["room"]["code"]

    guest = hub.connect("Guest")
    hub.send(guest, {"type": "join_room", "code": code})
    guest_id = guest.session_id
    assert hub.hub.sessions[guest_id].room_id is not None

    hub.advance(600.0)
    assert guest_id in hub.hub.sessions


@pytest.mark.asyncio
async def test_session_in_match_is_never_reaped() -> None:
    """ผู้เล่นที่หลุดจากเกมแล้ว มีนาฬิกาเดินและ AI คุมแทน ห้ามลืมจนกว่าจะออกจากเกม"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    first = hub.connect("One")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("Two")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    first_id = first.session_id
    hub.hub.disconnect(first)

    hub.advance(600.0)
    assert first_id in hub.hub.sessions


@pytest.mark.asyncio
async def test_queued_session_is_never_reaped() -> None:
    """คนที่ยังรอจับคู่อยู่ต้องอยู่ในคิว ไม่งั้นจะเข้าคิวไม่ได้"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    waiting = hub.connect("Waiting")
    hub.send(waiting, {"type": "quick_match"})
    waiting_id = waiting.session_id
    # ผู้เล่นที่หลุดแล้วถูกดึงออกจากคิวเสมอ จึงทดสอบส่วนนี้กับคนที่ยังต่ออยู่
    assert waiting_id in hub.hub.sessions

    hub.advance(600.0)
    assert waiting_id in hub.hub.sessions, "คนที่ยังเชื่อมต่ออยู่ต้องอยู่ในคิว"


@pytest.mark.asyncio
async def test_finished_match_is_released_when_everyone_left() -> None:
    """เกมที่จบแล้วและไม่มีคนอยู่ ต้องถูกปล่อยทันทีโดยไม่ต้องรอครบเวลา"""
    hub = HubHarness(session_ttl=60.0, reap_interval=10.0, finished_match_ttl=3600.0)
    await _start(hub)
    first = hub.connect("One")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("Two")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    match_id = _finish_match(hub, first, second)
    assert match_id in hub.hub.matches

    hub.hub.disconnect(first)
    hub.hub.disconnect(second)

    hub.advance(30.0)
    assert match_id not in hub.hub.matches


@pytest.mark.asyncio
async def test_finished_match_is_kept_while_players_watch_result() -> None:
    """ผู้เล่นที่ยังดูผลอยู่ต้องยังขอเล่นใหม่ได้ เกมห้ามถูกทิ้งทันทีที่จบ"""
    hub = HubHarness(session_ttl=60.0, reap_interval=10.0, finished_match_ttl=3600.0)
    await _start(hub)
    first = hub.connect("One")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("Two")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    match_id = _finish_match(hub, first, second)

    # ทั้งคู่ยังเชื่อมต่ออยู่ เกมต้องอยู่ต่อ
    hub.advance(30.0)
    assert match_id in hub.hub.matches


@pytest.mark.asyncio
async def test_finished_match_is_released_after_result_window() -> None:
    """ผู้เล่นค้างอยู่หน้าสรุปผลไม่เกินเวลาที่กำหนด แล้วต้องปล่อยเกมทิ้ง"""
    hub = HubHarness(session_ttl=60.0, reap_interval=10.0, finished_match_ttl=120.0)
    await _start(hub)
    first = hub.connect("One")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("Two")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    match_id = _finish_match(hub, first, second)

    # ยังไม่ครบเวลา
    hub.advance(60.0)
    assert match_id in hub.hub.matches

    # ครบเวลาแล้ว แม้ทั้งคู่ยังออนไลน์อยู่ก็ต้องทิ้ง
    hub.advance(120.0)
    assert match_id not in hub.hub.matches


@pytest.mark.asyncio
async def test_running_match_is_never_reaped() -> None:
    """เกมที่ยังไม่จบห้ามถูกปล่อยเด็ดขาด ไม่ว่าจะรอนานเท่าไร"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0, finished_match_ttl=1.0)
    await _start(hub)
    first = hub.connect("One")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("Two")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    match_id = str(first.state["matchId"])
    hub.advance(600.0)
    assert match_id in hub.hub.matches


@pytest.mark.asyncio
async def test_reaper_runs_without_cluster() -> None:
    """เก็บกวาดต้องทำงานแม้ไม่ได้ตั้ง Redis เพราะโหนดเดียวก็ต้องไม่รั่วเช่นกัน"""
    hub = HubHarness(session_ttl=10.0, reap_interval=5.0)
    assert hub.hub.cluster is None
    await _start(hub)

    connection = hub.connect("Solo")
    session_id = connection.session_id
    hub.hub.disconnect(connection)

    hub.advance(60.0)
    assert session_id not in hub.hub.sessions


@pytest.mark.asyncio
async def test_reaper_is_armed_only_once() -> None:
    """เรียก start ซ้ำต้องไม่ทำให้มีตัวเก็บกวาดสองตัวแล้วแย่งกันทำงาน"""
    hub = HubHarness(session_ttl=10.0, reap_interval=5.0)
    await _start(hub)
    await _start(hub)
    await _start(hub)
    # ถ้ามีหลายตัว รอบเก็บกวาดเดียวจะตั้งต่อหลายครั้ง และการนับจะเพี้ยน
    assert hub.scheduler.pending == 1


@pytest.mark.asyncio
async def test_bots_are_not_reaped() -> None:
    """บอทถูกจัดการชีวิตแยก ไม่ต้องให้ตัวเก็บกวาดมายุ่ง"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    bot = hub.hub._create_bot_session("easy")
    hub.advance(600.0)
    assert bot.id in hub.hub.sessions


@pytest.mark.asyncio
async def test_reaped_session_releases_its_queue_slot() -> None:
    """คิวต้องไม่เหลือร่องรอผู้เล่นที่ถูกลืมไปแล้ว คนอื่นต้องจับคู่ได้ต่อ"""
    hub = HubHarness(session_ttl=10.0, reap_interval=5.0)
    await _start(hub)
    stale = hub.connect("Stale")
    hub.send(stale, {"type": "quick_match"})
    stale_id = stale.session_id
    assert stale_id in hub.hub.queues.get("mak-si-kradan", [])

    # หลุดแล้วถูกดึงจากคิวทันที ซึ่งถูกต้อง เพราะคนที่ไม่ออนไลน์ไม่ควรถูกจับคู่
    hub.hub.disconnect(stale)
    assert stale_id not in hub.hub.queues.get("mak-si-kradan", [])

    hub.advance(60.0)
    assert stale_id not in hub.hub.sessions
    assert stale_id not in hub.hub.queues.get("mak-si-kradan", [])


@pytest.mark.asyncio
async def test_reaper_leaves_running_match_queue_alone() -> None:
    """ผู้เล่นที่ยังต่ออยู่ในคิวต้องไม่ถูกเก็บกวาด แม้จะยืนนิ่งนานมาก"""
    hub = HubHarness(session_ttl=1.0, reap_interval=1.0)
    await _start(hub)
    waiting = hub.connect("Standing by")
    hub.send(waiting, {"type": "quick_match"})
    assert waiting.session_id in hub.hub.queues.get("mak-si-kradan", [])

    hub.advance(600.0)
    assert waiting.session_id in hub.hub.queues.get("mak-si-kradan", [])
