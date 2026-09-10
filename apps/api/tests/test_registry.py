"""ทะเบียนเกม — สัญญาที่เกมใหม่ต้องทำตาม"""

import pytest

from makthai.domain import GameDefinition, GameRegistry, TurnBasedEngine
from makthai.domain.errors import ActionResult, CommonError
from makthai.games import registry


class DummyEngine(TurnBasedEngine):
    """เกมของเล่นที่ทำแค่ผลัดตา ใช้พิสูจน์ว่าสัญญาพอสำหรับเกมอื่นจริง"""

    def __init__(self, player_count: int = 2, mode: str = "default") -> None:
        super().__init__(player_count)
        self.mode = mode
        self.moves: list[tuple[int, str]] = []

    def apply(self, player, action, payload):
        if player != self.current:
            return ActionResult.fail(CommonError.NOT_YOUR_TURN)
        if action != "poke":
            return ActionResult.fail(CommonError.UNKNOWN_ACTION, action=action)
        self.moves.append((player, action))
        self.advance_turn(score_delta=1)
        return ActionResult.success()

    def view(self):
        return {"moves": len(self.moves), "mode": self.mode}

    def auto_play_turn(self):
        return self.apply(self.current, "poke", {})

    def stats(self):
        return {"moves": len(self.moves)}


def dummy_definition(game_id: str = "dummy", **overrides) -> GameDefinition:
    base = {
        "id": game_id,
        "icon": "🎲",
        "min_players": 2,
        "max_players": 4,
        "default_turn_seconds": 30,
        "modes": ("default",),
        "create": DummyEngine,
    }
    return GameDefinition(**{**base, **overrides})


def test_เกมแรกของแพลตฟอร์มลงทะเบียนตัวเองแล้ว():
    assert "mak-si-kradan" in registry
    definition = registry.require("mak-si-kradan")
    assert definition.min_players == 2
    assert definition.max_players == 4
    assert definition.has_bots
    assert "assisted" in definition.modes


def test_สร้างแมตช์ผ่านทะเบียนได้โดยไม่ต้องรู้จักตัวเกม():
    definition = registry.require("mak-si-kradan")
    engine = definition.create(player_count=3, mode="standard")
    assert engine.player_count == 3
    assert engine.is_active
    view = engine.view()
    assert len(view["board"]) == 64
    assert view["rules"]["forceMaximum"] is False


def test_เพิ่มเกมใหม่เข้าทะเบียนแล้วใช้งานได้ทันที():
    local = GameRegistry()
    local.register(dummy_definition())
    assert local.ids == ["dummy"]

    engine = local.require("dummy").create(player_count=2, mode="default")
    assert engine.current == 0
    assert engine.apply(0, "poke", {}).ok
    assert engine.current == 1, "ผลัดตาให้เองจากฐาน"
    assert engine.scores == [1, 0]


def test_ฐานเกมผลัดตาจัดการถอนตัวและจบเกมให้ทุกเกม():
    engine = DummyEngine(player_count=3)
    engine.scores = [5, 9, 1]
    assert engine.retire(1).ok
    assert engine.is_active
    assert engine.active_players() == [0, 2]

    assert engine.retire(2).ok
    assert not engine.is_active
    # คนถอนตัวชนะไม่ได้แม้คะแนนนำ
    assert engine.result is not None
    assert engine.result.winners == (0,)


def test_คนที่ถือเทิร์นอยู่ถอนตัวแล้วเทิร์นเดินต่อทันที():
    engine = DummyEngine(player_count=3)
    assert engine.current == 0
    engine.retire(0)
    assert engine.current == 1, "ไม่ค้างอยู่ที่คนที่ถอนตัวไปแล้ว"


def test_ทะเบียนกันการลงทะเบียนที่ไม่ถูกต้อง():
    local = GameRegistry()
    local.register(dummy_definition())

    with pytest.raises(ValueError, match="ลงทะเบียนไปแล้ว"):
        local.register(dummy_definition())
    with pytest.raises(ValueError, match="อย่างน้อย 2 ที่นั่ง"):
        local.register(dummy_definition("solo", min_players=1))
    with pytest.raises(ValueError, match="ไม่น้อยกว่าค่าต่ำสุด"):
        local.register(dummy_definition("weird", min_players=4, max_players=2))
    with pytest.raises(ValueError, match="ชุดกติกาอย่างน้อยหนึ่งชุด"):
        local.register(dummy_definition("modeless", modes=()))


def test_ขอเกมที่ไม่รู้จักได้เกมเริ่มต้นแทน():
    assert registry.resolve("ไม่มีเกมนี้").id == registry.default().id
    assert registry.resolve(None).id == registry.default().id
    assert registry.get("ไม่มีเกมนี้") is None


def test_ทุกเกมในทะเบียนทำตามสัญญาครบ():
    for definition in registry.all():
        engine = definition.create(player_count=definition.min_players, mode=definition.modes[0])
        assert isinstance(engine, TurnBasedEngine)
        assert engine.is_active
        assert isinstance(engine.view(), dict)
        assert isinstance(engine.stats(), dict)
        # ต้องเล่นแทนได้เสมอ ไม่งั้นที่นั่งที่ไม่มีคนคุมจะทำให้เกมค้าง
        assert engine.auto_play_turn().ok
