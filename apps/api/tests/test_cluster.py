"""เล่นข้ามเครื่อง

ยกสองโหนดขึ้นมาในโปรเซสเดียวแล้วต่อกันด้วย LocalCluster ผู้เล่นคนละโหนดต้องเห็นห้อง
ของกันและกัน เข้าห้องข้ามเครื่องได้ และเล่นจนจบเกมได้เหมือนอยู่เครื่องเดียวกัน
การกระจายที่ทดสอบไม่ได้คือการกระจายที่ไม่มีใครรู้ว่าพัง
"""

from __future__ import annotations

import pytest

from hub_harness import HubHarness
from makthai.realtime.cluster import LocalCluster, RemoteConnection


@pytest.fixture
def nodes():
    """สองโหนดที่คุยกันได้ — a เป็นเจ้าบ้าน b เป็นอีกเครื่อง"""
    a = HubHarness(cluster=LocalCluster("a"))
    return a, a.peer("b")


def make_room(node: HubHarness, host_name: str = "เจ้าของห้อง", **options):
    host = node.connect(host_name)
    options.setdefault("visibility", "public")
    node.send(host, {"type": "create_room", "gameId": "mak-si-kradan", **options})
    return host, host.last("room")["room"]


# ── รายการที่ทุกโหนดต้องเห็นตรงกัน ───────────────────────────────────────────


def test_ห้องสาธารณะของอีกเครื่องโผล่ในรายการ(nodes):
    a, b = nodes
    make_room(a, "คนที่เครื่องเอ")

    watcher = b.connect("คนที่เครื่องบี")
    b.send(watcher, {"type": "list_rooms"})
    rooms = watcher.last("rooms")["rooms"]
    assert [room["hostName"] for room in rooms] == ["คนที่เครื่องเอ"]


def test_ห้องส่วนตัวไม่โผล่ในรายการของอีกเครื่อง(nodes):
    a, b = nodes
    make_room(a, visibility="private")

    watcher = b.connect()
    b.send(watcher, {"type": "list_rooms"})
    assert watcher.last("rooms")["rooms"] == []


def test_ยอดคนออนไลน์รวมทั้งคลัสเตอร์(nodes):
    a, b = nodes
    a.connect("หนึ่ง")
    a.connect("สอง")
    watcher = b.connect("สาม")

    assert watcher.last("lobby")["online"] == 3


def test_รายการห้องอัปเดตเองเมื่ออีกเครื่องสร้างห้อง(nodes):
    a, b = nodes
    watcher = b.connect()
    watcher.clear()

    make_room(a, "คนที่เครื่องเอ")

    # ไม่ได้ขอรายการใหม่เลย แต่ต้องได้รับเพราะของเปลี่ยนที่อีกเครื่อง
    assert watcher.last("rooms")["rooms"][0]["hostName"] == "คนที่เครื่องเอ"


def test_โหนดที่เงียบไปถูกลบออกจากสำเนา(nodes):
    a, b = nodes
    make_room(a)
    watcher = b.connect()
    b.send(watcher, {"type": "list_rooms"})
    assert len(watcher.last("rooms")["rooms"]) == 1

    b.hub.peers["a"].heard_at -= 3600
    b.hub._heartbeat()

    b.send(watcher, {"type": "list_rooms"})
    assert watcher.last("rooms")["rooms"] == []


# ── เข้าห้องและเล่นข้ามเครื่อง ────────────────────────────────────────────────


def test_เข้าห้องด้วยรหัสที่อยู่อีกเครื่อง(nodes):
    a, b = nodes
    host, room = make_room(a, "เจ้าของ")

    guest = b.connect("แขก")
    b.send(guest, {"type": "join_room", "code": room["code"]})

    # ทั้งสองฝั่งเห็นห้องเดียวกันและเห็นกันครบ
    assert [p["name"] for p in guest.last("room")["room"]["players"]] == ["เจ้าของ", "แขก"]
    assert [p["name"] for p in host.last("room")["room"]["players"]] == ["เจ้าของ", "แขก"]
    # สถานะห้องอยู่ที่เครื่องเจ้าของเท่านั้น ไม่ได้ถูกคัดลอกไปไว้สองที่
    assert len(a.hub.rooms) == 1
    assert b.hub.rooms == {}


def test_รหัสห้องที่ไม่มีอยู่จริงยังตอบว่าไม่พบ(nodes):
    _, b = nodes
    guest = b.connect()
    b.send(guest, {"type": "join_room", "code": "ZZZZ"})
    assert guest.last("error")["code"] == "room_not_found"


def test_เล่นจนจบเกมข้ามเครื่องได้(nodes):
    a, b = nodes
    host, room = make_room(a, "เจ้าของ")
    guest = b.connect("แขก")
    b.send(guest, {"type": "join_room", "code": room["code"]})
    a.send(host, {"type": "start_room"})

    assert host.last("match_start") is not None
    assert guest.last("match_start") is not None

    players = {host.seat: (a, host), guest.seat: (b, guest)}
    for _ in range(6):
        state = host.state
        if state["view"]["status"] != "active":
            break
        node, connection = players[state["view"]["current"]]
        node.play_turn(connection)

    # ทั้งสองฝั่งเห็นกระดานเดียวกันเสมอ แม้คนละเครื่อง
    assert guest.game_view["board"] == host.game_view["board"]
    assert guest.game_view["turn"] == host.game_view["turn"]


def test_ยอมแพ้จากอีกเครื่องจบเกมได้(nodes):
    a, b = nodes
    host, room = make_room(a)
    guest = b.connect("แขก")
    b.send(guest, {"type": "join_room", "code": room["code"]})
    a.send(host, {"type": "start_room"})

    b.send(guest, {"type": "resign"})

    assert host.last("match_end") is not None
    assert guest.last("match_end") is not None


def test_ออกจากห้องข้ามเครื่องแล้วกลับมาตัดสินใจเองได้(nodes):
    a, b = nodes
    _, room = make_room(a)
    guest = b.connect("แขก")
    b.send(guest, {"type": "join_room", "code": room["code"]})
    assert b.hub.sessions[guest.session_id].home == "a"

    b.send(guest, {"type": "leave_room"})

    # เครื่องเจ้าของไม่ต้องแบก session ของคนที่ไม่ได้อยู่ในห้องแล้ว
    assert b.hub.sessions[guest.session_id].home is None
    assert guest.session_id not in a.hub.sessions

    # และสร้างห้องของตัวเองที่เครื่องตัวเองได้ตามปกติ
    b.send(guest, {"type": "create_room", "gameId": "mak-si-kradan"})
    assert guest.last("room") is not None
    assert len(b.hub.rooms) == 1


def test_หลุดจากอีกเครื่องแล้วเจ้าของห้องรู้(nodes):
    a, b = nodes
    host, room = make_room(a)
    guest = b.connect("แขก")
    b.send(guest, {"type": "join_room", "code": room["code"]})
    a.send(host, {"type": "start_room"})
    host.clear()

    b.hub.disconnect(guest)

    status = host.last("player_status")
    assert status is not None and status["connected"] is False


def test_ต่อกลับเข้าอีกเครื่องแล้วได้เกมที่ค้างอยู่คืน(nodes):
    a, b = nodes
    host, room = make_room(a)
    guest = b.connect("แขก")
    token = guest.session_token
    b.send(guest, {"type": "join_room", "code": room["code"]})
    a.send(host, {"type": "start_room"})
    b.hub.disconnect(guest)

    # กลับมาต่อเครื่องที่สาม ซึ่งไม่เคยรู้จักผู้เล่นคนนี้มาก่อนเลย
    c = a.peer("c")
    back = c.connect(token=token)

    assert back.last("match_start") is not None
    assert back.state["view"]["board"] == host.game_view["board"]


# ── จับคู่อัตโนมัติข้ามเครื่อง ─────────────────────────────────────────────────


def test_จับคู่คนที่รออยู่คนละเครื่องเข้าด้วยกัน(nodes):
    a, b = nodes
    first = a.connect("คนแรก")
    a.send(first, {"type": "quick_match", "gameId": "mak-si-kradan"})
    assert first.last("queue")["searching"] is True

    second = b.connect("คนที่สอง")
    b.send(second, {"type": "quick_match", "gameId": "mak-si-kradan"})

    assert first.last("queue")["searching"] is False
    assert first.last("match_start") is not None
    assert second.last("match_start") is not None
    assert {p["name"] for p in second.last("match_start")["players"]} == {"คนแรก", "คนที่สอง"}


def test_มีคู่ที่เครื่องเดียวกันแล้วไม่ต้องไปขอข้ามเครื่อง(nodes):
    """จับคู่ในเครื่องก่อนเสมอ ข้ามเครื่องเป็นทางเลือกเมื่อไม่มีใครรออยู่ที่นี่"""
    a, b = nodes
    far = b.connect("คนไกล")
    b.send(far, {"type": "quick_match", "gameId": "mak-si-kradan"})
    b.send(far, {"type": "cancel_quick_match"})

    near = a.connect("คนใกล้")
    a.send(near, {"type": "quick_match", "gameId": "mak-si-kradan"})
    partner = a.connect("อีกคนใกล้")
    a.send(partner, {"type": "quick_match", "gameId": "mak-si-kradan"})

    assert {p["name"] for p in partner.last("match_start")["players"]} == {"คนใกล้", "อีกคนใกล้"}
    assert far.last("match_start") is None


def test_คนที่ถูกจับคู่ไปแล้วไม่ถูกจับซ้ำ(nodes):
    a, b = nodes
    waiting = a.connect("คนรอ")
    a.send(waiting, {"type": "quick_match", "gameId": "mak-si-kradan"})

    c = a.peer("c")
    first = b.connect("คนที่สอง")
    b.send(first, {"type": "quick_match", "gameId": "mak-si-kradan"})
    second = c.connect("คนที่สาม")
    c.send(second, {"type": "quick_match", "gameId": "mak-si-kradan"})

    assert first.last("match_start") is not None
    # คนที่มาทีหลังไม่ได้คนที่ถูกจับไปแล้ว ต้องรอต่อ
    assert second.last("match_start") is None
    assert second.last("queue")["searching"] is True


# ── สถานะเพื่อน ─────────────────────────────────────────────────────────────


def test_เพื่อนที่ต่ออยู่อีกเครื่องนับว่าออนไลน์(nodes):
    a, b = nodes
    from hub_harness import SECRET
    from makthai.auth import sign_token

    token = sign_token("user_ไกล", "เพื่อน", "user", SECRET)
    b.connect(token=token)

    assert a.hub.online_ids({"user_ไกล", "user_ไม่มีตัวตน"}) == {"user_ไกล"}


# ── ท่อส่งข้อความ ────────────────────────────────────────────────────────────


def test_ซองที่ไม่รู้จักไม่ทำให้ระเบิด(nodes):
    a, _ = nodes
    for envelope in ({}, {"kind": "อะไรไม่รู้"}, {"kind": "forward"}, {"from": "a"}):
        a.hub._on_envelope(envelope)


def test_ปิดการเชื่อมต่อข้ามเครื่องส่งถึงปลายทางจริง(nodes):
    a, b = nodes
    guest = b.connect("แขก")
    RemoteConnection(a.hub.cluster, "b", guest.session_id).close()
    assert guest.closed is True
