"""ห้อง บอทในห้อง คำเชิญ และเกมหลายคน"""

from hub_harness import HubHarness


def test_สร้างห้องแล้วเข้าด้วยรหัสและเริ่มเกม():
    harness = HubHarness()
    host = harness.connect(name="Host")
    guest = harness.connect(name="Guest")

    harness.send(host, {"type": "create_room"})
    room = host.last("room")["room"]
    assert len(room["code"]) == 6
    assert room["inviteUrl"].endswith(room["code"])
    assert room["gameId"] == "mak-si-kradan"
    assert room["players"][0]["name"] == "Host"

    harness.send(guest, {"type": "join_room", "code": room["code"].lower()})
    assert len(guest.last("room")["room"]["players"]) == 2
    assert host.last("room")["room"]["status"] == "ready"

    harness.send(host, {"type": "start_room"})
    assert host.last("match_start")["matchId"] == guest.last("match_start")["matchId"]


def test_รหัสผิดแจ้งด้วยรหัสข้อผิดพลาด():
    harness = HubHarness()
    guest = harness.connect(name="Guest")
    harness.send(guest, {"type": "join_room", "code": "ZZZZZZ"})
    error = guest.last("error")
    assert error["code"] == "room_not_found"
    assert error["params"]["code"] == "ZZZZZZ"


def test_เฉพาะเจ้าของห้องเริ่มเกมได้และต้องมีครบสองคน():
    harness = HubHarness()
    host = harness.connect(name="Host")
    guest = harness.connect(name="Guest")

    harness.send(host, {"type": "create_room"})
    harness.send(host, {"type": "start_room"})
    assert host.last("error")["code"] == "room_needs_players"

    harness.send(guest, {"type": "join_room", "code": host.last("room")["room"]["code"]})
    harness.send(guest, {"type": "start_room"})
    assert guest.last("error")["code"] == "not_room_host"


def test_เจ้าของห้องออกแล้วห้องปิด():
    harness = HubHarness()
    host = harness.connect(name="Host")
    guest = harness.connect(name="Guest")
    harness.send(host, {"type": "create_room"})
    harness.send(guest, {"type": "join_room", "code": host.last("room")["room"]["code"]})

    harness.send(host, {"type": "leave_room"})
    assert guest.last("room_closed")["code"] == "room_closed_host_left"
    assert harness.hub.stats["rooms"] == 0


def test_ห้องเต็มตามจำนวนที่ตั้งไว้():
    harness = HubHarness()
    host = harness.connect(name="Host")
    harness.send(host, {"type": "create_room", "capacity": 2})
    code = host.last("room")["room"]["code"]

    harness.send(harness.connect(name="Second"), {"type": "join_room", "code": code})
    third = harness.connect(name="Third")
    harness.send(third, {"type": "join_room", "code": code})
    assert third.last("error")["code"] == "room_full"


def test_ห้องสาธารณะโผล่ในรายการ_ส่วนห้องส่วนตัวไม่โผล่():
    harness = HubHarness()
    host = harness.connect(name="Host")
    seeker = harness.connect(name="Seeker")

    harness.send(host, {"type": "create_room", "visibility": "public", "capacity": 3})
    harness.send(seeker, {"type": "list_rooms"})
    rooms = seeker.last("rooms")["rooms"]
    assert len(rooms) == 1
    assert rooms[0]["hostName"] == "Host"
    assert rooms[0]["capacity"] == 3
    # ไม่เปิดเผยรหัสห้องในรายการสาธารณะ
    assert host.last("room")["room"]["code"] not in str(rooms[0])

    harness.send(host, {"type": "leave_room"})
    other = harness.connect(name="Other")
    harness.send(other, {"type": "create_room", "visibility": "private"})
    harness.send(seeker, {"type": "list_rooms"})
    assert seeker.last("rooms")["rooms"] == []


def test_เจ้าของห้องเพิ่มและเอาบอทออกได้():
    harness = HubHarness()
    host = harness.connect(name="Host")
    harness.send(host, {"type": "create_room", "capacity": 3})

    harness.send(host, {"type": "add_bot", "level": "hard"})
    harness.send(host, {"type": "add_bot", "level": "easy"})
    room = host.last("room")["room"]
    assert len(room["players"]) == 3
    bots = [p for p in room["players"] if p.get("bot")]
    assert len(bots) == 2
    assert bots[0]["name"] == "AI", "ชื่อบอทเป็นกลางทางภาษา"
    assert bots[0]["connected"] is True

    harness.send(host, {"type": "add_bot"})
    assert host.last("error")["code"] == "room_full_for_bot"

    harness.send(host, {"type": "remove_bot", "playerId": bots[1]["id"]})
    assert len(host.last("room")["room"]["players"]) == 2


def test_เติมบอทได้ตั้งแต่ตอนสร้างห้อง():
    harness = HubHarness()
    host = harness.connect(name="Host")
    harness.send(host, {"type": "create_room", "capacity": 4, "bots": 2, "botLevel": "hard"})
    room = host.last("room")["room"]
    assert len([p for p in room["players"] if p.get("bot") == "hard"]) == 2
    assert room["custom"] is True, "ตั้งค่าเองแล้วไม่นับอันดับ"


def test_คนที่ไม่ใช่เจ้าของห้องยุ่งกับบอทไม่ได้():
    harness = HubHarness()
    host = harness.connect(name="Host")
    guest = harness.connect(name="Guest")
    harness.send(host, {"type": "create_room", "capacity": 4})
    harness.send(guest, {"type": "join_room", "code": host.last("room")["room"]["code"]})

    harness.send(guest, {"type": "add_bot", "level": "easy"})
    assert guest.last("error")["code"] == "not_room_host_bots"


def test_ปิดห้องแล้วบอทในห้องถูกเก็บกวาด():
    harness = HubHarness()
    host = harness.connect(name="Host")
    harness.send(host, {"type": "create_room", "capacity": 4})
    harness.send(host, {"type": "add_bot", "level": "easy"})
    harness.send(host, {"type": "add_bot", "level": "easy"})
    assert harness.hub.stats["sessions"] == 3

    harness.send(host, {"type": "leave_room"})
    assert harness.hub.stats["rooms"] == 0
    assert harness.hub.stats["sessions"] == 1


def test_ชวนเพื่อนเข้าห้องแล้วเขาเข้าด้วยรหัส():
    harness = HubHarness()
    host = harness.connect(name="Host")
    mate = harness.connect(name="Mate")
    mate_id = mate.last("session")["id"]

    harness.send(host, {"type": "create_room", "capacity": 2})
    harness.send(host, {"type": "invite_to_room", "targetId": mate_id})

    invite = mate.last("room_invite")
    assert invite["from"]["name"] == "Host"
    assert invite["code"] == host.last("room")["room"]["code"]
    assert host.last("info")["code"] == "invite_sent"

    # ตอบรับคือการเข้าห้องด้วยรหัสธรรมดา ไม่มีสถานะคำเชิญฝั่งเซิร์ฟเวอร์
    harness.send(mate, {"type": "join_room", "code": invite["code"]})
    assert len(mate.last("room")["room"]["players"]) == 2


def test_ยังไม่อยู่ในห้องก็ชวนใครไม่ได้():
    harness = HubHarness()
    host = harness.connect(name="Host")
    mate = harness.connect(name="Mate")
    harness.send(host, {"type": "invite_to_room", "targetId": mate.last("session")["id"]})
    assert host.last("error")["code"] == "invite_needs_room"


def test_เล่นสี่คนได้และที่นั่งครบไม่ซ้ำ():
    harness = HubHarness()
    host = harness.connect(name="P1")
    harness.send(host, {"type": "create_room", "capacity": 4, "visibility": "public"})
    code = host.last("room")["room"]["code"]

    others = []
    for name in ("P2", "P3", "P4"):
        conn = harness.connect(name=name)
        harness.send(conn, {"type": "join_room", "code": code})
        others.append(conn)

    harness.send(host, {"type": "start_room"})
    view = host.game_view
    assert view["playerCount"] == 4
    assert view["scores"] == [0, 0, 0, 0]
    assert sorted(conn.seat for conn in [host, *others]) == [0, 1, 2, 3]


def test_เกมสามคน_คนหนึ่งยอมแพ้อีกสองคนเล่นต่อ():
    harness = HubHarness()
    host = harness.connect(name="P1")
    harness.send(host, {"type": "create_room", "capacity": 3})
    code = host.last("room")["room"]["code"]
    p2 = harness.connect(name="P2")
    p3 = harness.connect(name="P3")
    harness.send(p2, {"type": "join_room", "code": code})
    harness.send(p3, {"type": "join_room", "code": code})
    harness.send(host, {"type": "start_room"})

    harness.send(p2, {"type": "resign"})
    assert host.last("match_end") is None
    assert host.game_view["retired"] == [p2.seat]
    assert host.game_view["status"] == "active"

    harness.send(p3, {"type": "resign"})
    assert host.last("match_end")["result"]["winners"] == [host.seat]


def test_โหวตจบเกมสามคนต้องครบทุกคนที่ยังอยู่():
    harness = HubHarness()
    host = harness.connect(name="P1")
    harness.send(host, {"type": "create_room", "capacity": 3})
    code = host.last("room")["room"]["code"]
    p2 = harness.connect(name="P2")
    p3 = harness.connect(name="P3")
    harness.send(p2, {"type": "join_room", "code": code})
    harness.send(p3, {"type": "join_room", "code": code})
    harness.send(host, {"type": "start_room"})

    harness.send(host, {"type": "offer_end"})
    harness.send(p2, {"type": "respond_end", "accept": True})
    assert host.last("match_end") is None
    assert host.state["endVotesNeeded"] == 3

    # เหลือสองคนที่ยังเล่นอยู่และทั้งคู่โหวตแล้ว เกมต้องจบทันที
    harness.send(p3, {"type": "resign"})
    assert host.last("match_end")["result"]["reason"] == "agreement"
