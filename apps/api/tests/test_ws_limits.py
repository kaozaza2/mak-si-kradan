"""กันการยิงรัวผ่าน WebSocket และจำกัดจำนวนการเชื่อมต่อ

ก่อนหน้านี้ช่อง WebSocket เปิดสาธารณะไม่มีอะไรคุมเลย ใครก็ต่อได้ไม่จำกัด
ยิง hello สร้าง session ทิ้งได้ไม่จำกัด และยิงข้อความรัว ๆ ได้ตามใจ
ที่นี่พิสูจน์ว่ามีกันแล้ว และกันโดยไม่ไปขวางการเล่นปกติ
"""

from __future__ import annotations

from hub_harness import FakeConnection, HubHarness
from makthai.realtime.cluster import LocalCluster
from makthai.realtime.hub import HELLO_LIMIT, MESSAGE_LIMIT, ConnectionGate


class PeerConnection(FakeConnection):
    """การเชื่อมต่อปลอมที่มี IP เหมือนของจริง เพื่อทดสอบการจำกัดต่อ IP"""

    def __init__(self, peer: str) -> None:
        super().__init__()
        self.peer = peer


def hub_with_peer(peer: str) -> tuple[HubHarness, PeerConnection]:
    hub = HubHarness()
    return hub, PeerConnection(peer)


# ── จำกัดการสร้าง session ───────────────────────────────────────────────────


def test_hello_is_allowed_for_a_normal_player() -> None:
    hub, connection = hub_with_peer("1.2.3.4")
    hub.hub.handle(connection, {"type": "hello", "name": "ปกติ"})

    assert connection.session_id is not None
    assert connection.last("session") is not None


def test_flooding_hello_stops_creating_sessions() -> None:
    """ยิง hello ซ้ำจาก IP เดียวต้องถูกจำกัด ไม่ใช่สร้าง session ได้ไม่จำกัด"""
    hub, _ = hub_with_peer("5.6.7.8")
    for _ in range(HELLO_LIMIT * 5):
        hub.hub.handle(PeerConnection("5.6.7.8"), {"type": "hello"})

    assert len(hub.hub.sessions) <= HELLO_LIMIT


def test_hello_flood_returns_an_error_code() -> None:
    """ต้องบอก client ด้วยว่าถูกจำกัด ไม่ใช่เงียบไปเฉย ๆ"""
    hub, _ = hub_with_peer("9.9.9.9")
    last: PeerConnection | None = None
    for _ in range(HELLO_LIMIT + 2):
        last = PeerConnection("9.9.9.9")
        hub.hub.handle(last, {"type": "hello"})

    assert last is not None
    assert last.last("error")["code"] == "rate_limited"


def test_hello_limit_recovers_after_the_window() -> None:
    """จำกัดเฉพาะช่วงเวลา ไม่ใช่แบล็อกถาวร"""
    hub, connection = hub_with_peer("3.3.3.3")
    for _ in range(HELLO_LIMIT + 1):
        hub.hub.handle(PeerConnection("3.3.3.3"), {"type": "hello"})
    assert connection.last("error") is None

    # เลยหน้าต่างเวลาแล้วต้องกลับมาได้
    hub.advance(400.0)
    fresh = PeerConnection("3.3.3.3")
    hub.hub.handle(fresh, {"type": "hello"})
    assert fresh.session_id is not None


def test_different_peers_have_separate_hello_budgets() -> None:
    """คนละ IP ต้องได้โควตาของตัวเอง ไม่ใช่แย่งกัน"""
    hub = HubHarness()
    for i in range(HELLO_LIMIT * 3):
        hub.hub.handle(PeerConnection(f"10.0.0.{i % 40}"), {"type": "hello"})

    assert len(hub.hub.sessions) >= HELLO_LIMIT


def test_one_hello_per_connection_reuses_the_session() -> None:
    """ต่อใหม่แต่ส่ง token เดิม ต้องได้ session เดิม ไม่ใช่สร้างใหม่"""
    hub = HubHarness()
    first = PeerConnection("4.4.4.4")
    hub.hub.handle(first, {"type": "hello", "name": "กลับมา"})
    token = first.last("session")["token"]

    second = PeerConnection("4.4.4.4")
    hub.hub.handle(second, {"type": "hello", "token": token})

    assert second.session_id == first.session_id


# ── จำกัดความถี่ข้อความ ─────────────────────────────────────────────────────


def test_normal_play_is_not_rate_limited() -> None:
    """การเล่นจริงต้องไม่โดนตัดบัง คิวและการเดินเกมต้องทำงาน"""
    hub = HubHarness()
    player = hub.connect("A")
    hub.send(player, {"type": "quick_match"})
    second = hub.connect("B")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    hub.play_turn(player)

    assert player.closed is False


def test_message_flood_cuts_the_connection() -> None:
    """ยิงข้อความรัวต้องถูกตัด ไม่ใช่ปล่อยให้กิน CPU ต่อ"""
    hub = HubHarness()
    connection = PeerConnection("7.7.7.7")
    hub.hub.handle(connection, {"type": "hello"})

    for _ in range(MESSAGE_LIMIT * 3):
        hub.hub.handle(connection, {"type": "list_games"})

    assert connection.closed is True


def test_message_limit_is_per_connection_not_per_player() -> None:
    """ผู้เล่นคนเดียวเปิดหลายแท็บต้องได้โควตาเต็มแต่แท็บ ไม่ใช่แบ่งกัน"""
    hub = HubHarness()
    tabs = [PeerConnection("8.8.8.8") for _ in range(3)]
    for tab in tabs:
        hub.hub.handle(tab, {"type": "hello"})

    for tab in tabs:
        for _ in range(MESSAGE_LIMIT - 1):
            hub.hub.handle(tab, {"type": "list_games"})

    assert all(not tab.closed for tab in tabs)


def test_message_budget_recovers_within_the_window() -> None:
    hub = HubHarness()
    connection = PeerConnection("2.2.2.2")
    hub.hub.handle(connection, {"type": "hello"})
    for _ in range(MESSAGE_LIMIT + 1):
        hub.hub.handle(connection, {"type": "list_games"})
    assert connection.closed is True

    hub.advance(2.0)
    fresh = PeerConnection("2.2.2.2")
    hub.hub.handle(fresh, {"type": "hello"})
    for _ in range(MESSAGE_LIMIT - 1):
        hub.hub.handle(fresh, {"type": "list_games"})
    assert not fresh.closed


# ── จำกัดจำนวนการเชื่อมต่อ ───────────────────────────────────────────────────


def test_gate_admits_up_to_the_per_peer_limit() -> None:
    gate = ConnectionGate(max_per_peer=3, max_total=100)
    assert [gate.admit("1.1.1.1") for _ in range(4)] == [True, True, True, False]


def test_gate_enforces_a_total_cap() -> None:
    """เพดานรวมคุมทั้งโหนด ไม่ใช่ต่อ IP เพราะการกระจายหลาย IP ก็กินทรัพยากรเท่ากัน"""
    gate = ConnectionGate(max_per_peer=10, max_total=3)
    assert [gate.admit(f"10.0.0.{i}") for i in range(4)] == [True, True, True, False]


def test_gate_release_frees_a_slot() -> None:
    gate = ConnectionGate(max_per_peer=1, max_total=10)
    assert gate.admit("1.1.1.1") is True
    assert gate.admit("1.1.1.1") is False

    gate.release("1.1.1.1")
    assert gate.admit("1.1.1.1") is True


def test_gate_total_returns_to_zero() -> None:
    """ตัวเลขต้องถอยกลับจริง ถ้าไม่งั้นหลังเล่นไปมาสายเพียงพอ ทุกคนจะติดเพดาน"""
    gate = ConnectionGate()
    for i in range(5):
        assert gate.admit(f"10.0.0.{i}")
    assert gate.total == 5

    for i in range(5):
        gate.release(f"10.0.0.{i}")
    assert gate.total == 0


def test_gate_release_of_unknown_peer_is_harmless() -> None:
    """finally block อาจเรียกซ้ำ ต้องไม่ทำให้ตัวเลขติดลบ"""
    gate = ConnectionGate()
    gate.release("ไม่เคยเข้ามา")
    gate.release("ไม่เคยเข้ามา")
    assert gate.total == 0


def test_gate_release_beyond_zero_stays_zero() -> None:
    gate = ConnectionGate()
    gate.admit("1.1.1.1")
    gate.release("1.1.1.1")
    gate.release("1.1.1.1")
    assert gate.total == 0


def test_gate_does_not_go_negative_under_many_releases() -> None:
    gate = ConnectionGate()
    for _ in range(10):
        gate.release("1.1.1.1")
    assert gate.total == 0


def test_gate_defaults_allow_normal_multi_tab_use() -> None:
    """คนปกติเปิดหลายแท็บต้องได้อยู่จริง"""
    gate = ConnectionGate()
    assert all(gate.admit("1.1.1.1") for _ in range(4))


# ── สถานะของโหนด ─────────────────────────────────────────────────────────────


def test_node_status_reports_standalone_mode() -> None:
    hub = HubHarness()
    hub.connect("A")

    status = hub.hub.node_status()

    assert status["clustered"] is False
    assert status["sessions"] >= 1


def test_node_status_reports_cluster_mode() -> None:
    hub = HubHarness(cluster=LocalCluster("node-a"))

    status = hub.hub.node_status()

    assert status["clustered"] is True
    assert status["node"] == "node-a"
    assert status["clusterConnected"] is True


def test_node_status_reports_cluster_outage() -> None:
    """Redis ล่มต้องบอกได้ว่าตัดการเชื่อมต่อข้ามเครื่องไม่ได้ ตอนนี้"""
    hub = HubHarness(cluster=LocalCluster("node-a"))
    hub.hub.cluster._connected = False

    assert hub.hub.node_status()["clusterConnected"] is False


def test_node_status_counts_what_exists() -> None:
    hub = HubHarness()
    first = hub.connect("A")
    hub.send(first, {"type": "quick_match"})
    second = hub.connect("B")
    hub.send(second, {"type": "quick_match"})
    hub.run_pending()

    status = hub.hub.node_status()

    assert status["sessions"] == 2
    assert status["matches"] == 1
    assert status["rooms"] == 0
