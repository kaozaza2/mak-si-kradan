"""การเล่นจริง — จับคู่ เดินเกม นาฬิกา บอท และการจบเกม"""

from hub_harness import FakeConnection, HubHarness


def pair_up(harness: HubHarness) -> tuple[FakeConnection, FakeConnection, FakeConnection]:
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match"})
    harness.send(b, {"type": "quick_match"})
    mover = a if a.seat == a.state["view"]["current"] else b
    return a, b, mover


def test_คนแรกเข้าคิว_คนที่สองจับคู่ทันที():
    harness = HubHarness()
    a = harness.connect(name="A")
    b = harness.connect(name="B")

    harness.send(a, {"type": "quick_match"})
    assert a.last("queue")["searching"] is True
    assert b.last("match_start") is None

    harness.send(b, {"type": "quick_match"})
    assert a.last("match_start")["matchId"] == b.last("match_start")["matchId"]
    assert a.seat != b.seat
    assert len([c for c in a.game_view["board"] if c >= 0]) == 60


def test_คิวแยกตามเกม():
    harness = HubHarness()
    a = harness.connect(name="A")
    b = harness.connect(name="B")
    harness.send(a, {"type": "quick_match", "gameId": "mak-si-kradan"})
    harness.send(b, {"type": "quick_match", "gameId": "ไม่มีเกมนี้"})
    # เกมที่ไม่รู้จักตกกลับมาเป็นเกมเริ่มต้น จึงเจอกัน
    assert a.last("match_start") is not None


def test_ยกเลิกคิวได้():
    harness = HubHarness()
    a = harness.connect(name="A")
    harness.send(a, {"type": "quick_match"})
    harness.send(a, {"type": "cancel_quick_match"})
    assert a.last("queue")["searching"] is False
    assert harness.hub.stats["queue"] == 0


def test_ผู้เล่นที่ยังไม่ถึงตาสั่งอะไรไม่ได้():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    waiter = b if mover is a else a
    harness.act(waiter, "select", square=mover.game_view["selectable"][0])
    assert waiter.last("error")["code"] == "not_your_turn"


def test_เลือกช่องที่เล่นไม่ได้ถูกปฏิเสธและสถานะไม่เปลี่ยน():
    harness = HubHarness()
    _, _, mover = pair_up(harness)
    turn_before = mover.game_view["turn"]
    harness.act(mover, "select", square=27)  # ช่องกลางที่ว่างอยู่
    assert mover.last("error")["code"] == "empty_square"
    assert mover.game_view["turn"] == turn_before


def test_กินสำเร็จได้คะแนนและสลับตา_ทั้งสองฝั่งเห็นเหมือนกัน():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    seat = mover.seat
    harness.play_turn(mover)

    view = mover.game_view
    assert view["scores"][seat] == 1
    assert view["current"] != seat
    assert len([c for c in view["board"] if c >= 0]) == 59
    assert a.game_view == b.game_view


def test_กลับเข้าเกมเดิมได้หลังหลุด():
    harness = HubHarness()
    a, b, _ = pair_up(harness)
    token = a.session_token
    match_id = a.last("match_start")["matchId"]

    harness.hub.disconnect(a)
    assert b.last("player_status")["connected"] is False

    back = harness.connect(token=token)
    assert back.last("match_start")["matchId"] == match_id
    assert back.seat == a.seat
    assert back.game_view["board"] == b.game_view["board"]
    assert b.last("player_status")["connected"] is True


def test_ยอมแพ้แล้วอีกฝ่ายชนะ():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    other = b if mover is a else a
    harness.send(mover, {"type": "resign"})

    end = a.last("match_end")
    assert end["result"]["reason"] == "resign"
    assert end["result"]["winners"] == [other.seat]
    assert b.last("match_end")["matchId"] == end["matchId"]


def test_โหวตจบเกมต้องได้เสียงครบ():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    other = b if mover is a else a

    harness.send(mover, {"type": "offer_end"})
    assert other.last("end_offer")["by"] == mover.seat
    assert a.last("match_end") is None
    assert a.state["endVotesNeeded"] == 2

    harness.send(other, {"type": "respond_end", "accept": True})
    assert a.last("match_end")["result"]["reason"] == "agreement"


def test_ผู้เสนอถอนคำขอเองได้และโหวตไม่ค้าง():
    harness = HubHarness()
    a, _, mover = pair_up(harness)
    harness.send(mover, {"type": "offer_end"})
    assert a.state["endVotes"] == [mover.seat]

    harness.send(mover, {"type": "respond_end", "accept": False})
    assert a.last("info")["code"] == "end_offer_cancelled"
    assert a.state["endOfferBy"] is None
    assert a.state["endVotes"] == []
    assert a.last("match_end") is None


def test_ปฏิเสธคำขอแล้วเล่นต่อ():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    other = b if mover is a else a
    harness.send(mover, {"type": "offer_end"})
    harness.send(other, {"type": "respond_end", "accept": False})
    assert a.last("info")["code"] == "end_offer_declined"
    assert a.state["endOfferBy"] is None
    assert a.last("match_end") is None


def test_ขอเล่นใหม่ต้องครบทั้งสองฝ่ายและหมุนที่นั่ง():
    harness = HubHarness()
    a, b, mover = pair_up(harness)
    first_match = a.last("match_start")["matchId"]
    seat_before = a.seat

    harness.send(mover, {"type": "resign"})
    harness.send(a, {"type": "rematch"})
    assert a.last("match_start")["matchId"] == first_match

    harness.send(b, {"type": "rematch"})
    assert a.last("match_start")["matchId"] != first_match
    assert a.seat != seat_before
    assert len([c for c in a.game_view["board"] if c >= 0]) == 60


def test_บอกทุกคนว่าใครได้เดินก่อน():
    harness = HubHarness()
    a, _, _ = pair_up(harness)
    info = next(m for m in a.all("info") if m["code"] == "first_player")
    first_seat = a.state["view"]["current"]
    assert info["params"]["name"] == a.last("match_start")["players"][first_seat]["name"]


def test_ลำดับที่นั่งถูกสุ่มไม่ใช่ตายตัว():
    seats = set()
    for _ in range(40):
        harness = HubHarness()
        a, _, _ = pair_up(harness)
        seats.add(a.seat)
        if len(seats) == 2:
            break
    assert seats == {0, 1}
