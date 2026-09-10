"""บอท นาฬิกาเทิร์น และ AI ที่เข้าคุมแทนคนที่หายไป"""

from hub_harness import HubHarness


def test_เล่นกับบอทได้ทันทีและบอทเดินเอง():
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "easy"})

    start = player.last("match_start")
    bot = next(p for p in start["players"] if p.get("bot"))
    assert bot["bot"] == "easy"
    assert bot["connected"] is True
    assert start["ranked"] is False, "เล่นกับบอทไม่นับอันดับ"

    if player.game_view["current"] == player.seat:
        harness.play_turn(player)
    harness.run_pending()
    assert player.game_view["turn"] > 1
    assert player.game_view["lastTurn"] is not None


def test_ระดับบอทที่ไม่รู้จักถูกปฏิเสธ():
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "เทพ"})
    assert player.last("error")["code"] == "bad_ai_level"
    assert harness.hub.stats["matches"] == 0


def test_ขอเล่นใหม่กับบอทแล้วบอทยังเป็นบอท():
    """บอทมีอายุเท่ากับแมตช์ ถ้าใช้ไอดีเดิมที่นั่งจะกลายเป็นคนหลุดที่ไม่มีใครเดินให้"""
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "easy"})
    first = player.last("match_start")["matchId"]

    harness.send(player, {"type": "resign"})
    harness.send(player, {"type": "rematch"})

    second = player.last("match_start")
    assert second["matchId"] != first
    bot = next(p for p in second["players"] if p["id"] != player.last("session")["id"])
    assert bot["bot"] == "easy"
    assert bot["connected"] is True
    assert bot["name"] == "AI"


def test_ออกจากเกมแล้วบอทถูกเก็บกวาด():
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "easy"})
    assert harness.hub.stats["sessions"] == 2

    harness.send(player, {"type": "leave_match"})
    assert harness.hub.stats["matches"] == 0
    assert harness.hub.stats["sessions"] == 1


def test_บอทไม่ต้องโหวต_ขอจบเกมกับบอทจบทันที():
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "easy"})
    harness.send(player, {"type": "offer_end"})
    assert player.last("match_end")["result"]["reason"] == "agreement"


def test_หมดเวลาแล้ว_AI_เข้าคุมที่นั่งและเดินต่อให้():
    harness = HubHarness(turn_seconds=10)
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match"})
    harness.send(b, {"type": "quick_match"})

    idle_seat = a.state["view"]["current"]
    turn_before = a.game_view["turn"]
    harness.advance(11)
    harness.run_pending()

    assert a.last("info")["code"] in {"turn_timeout_autopilot", "first_player"}
    assert idle_seat in a.state["autopilot"]
    assert a.game_view["turn"] > turn_before, "AI เดินต่อให้จริง"


def test_เจ้าของที่นั่งลงมือเองแล้วได้คุมกลับทันที():
    harness = HubHarness(turn_seconds=10)
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match"})
    harness.send(b, {"type": "quick_match"})

    idle_seat = a.state["view"]["current"]
    idle = a if a.seat == idle_seat else b
    harness.advance(11)
    assert idle_seat in a.state["autopilot"]

    # แม้จะสั่งอะไรที่ผิดกติกา ก็ถือว่ากลับมาแล้ว
    harness.act(idle, "select", square=27)
    assert idle_seat not in a.state["autopilot"]
    assert a.last("autopilot")["on"] is False


def test_หลุดการเชื่อมต่อแล้ว_AI_เข้าคุมหลังพ้นเวลารอ_และคืนคุมเมื่อกลับมา():
    harness = HubHarness(autopilot_grace=5.0)
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match"})
    harness.send(b, {"type": "quick_match"})

    seat_a = a.seat
    token = a.session_token
    harness.hub.disconnect(a)
    # ยังไม่พ้นเวลารอ ยังไม่ให้ AI คุม
    harness.advance(2)
    assert seat_a not in b.state["autopilot"]

    harness.advance(5)
    assert seat_a in b.state["autopilot"]

    back = harness.connect(token=token)
    assert seat_a not in back.state["autopilot"]
    assert b.last("autopilot")["on"] is False


def test_ออกจากเกมไม่ใช่การยอมแพ้_AI_คุมที่นั่งต่อ():
    harness = HubHarness()
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match"})
    harness.send(b, {"type": "quick_match"})
    seat_a = a.seat

    harness.send(a, {"type": "leave_match"})
    assert b.last("match_end") is None
    assert seat_a in b.state["autopilot"]
    assert seat_a not in b.game_view["retired"]


def test_ไม่มีใครดูอยู่บอทหยุดพัก_ไม่เดินเกมทิ้งเปล่า():
    harness = HubHarness()
    player = harness.connect(name="เก้า")
    harness.send(player, {"type": "play_ai", "level": "easy"})
    harness.run_pending()
    turn_before = player.game_view["turn"]

    harness.hub.disconnect(player)
    fired = harness.run_pending()
    match = next(iter(harness.hub.matches.values()))
    assert match.engine.turn <= turn_before + 1
    assert fired < 50, "ไม่ควรเดินเกมรัวจนจบทั้งที่ไม่มีคนดู"
