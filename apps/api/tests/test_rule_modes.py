"""โหมดกติกา — ความผิดพลาดแบบกระดานจริงต้องเกิดขึ้นได้"""

from conftest import EMPTY_ROW, game_with
from makthai.games.mak_si_kradan import MakError, RuleMode, index_of


def chain_game(mode: RuleMode):
    """● ○ . ○ . — หมากที่ a8 กินได้ 2 ตัวถ้าไล่จนสุด"""
    return game_with(["oo.o...."] + [EMPTY_ROW] * 7, mode=mode)


def test_โหมดช่วยคำนวณยังบังคับทุกอย่าง():
    game = chain_game(RuleMode.ASSISTED)
    game.select(index_of(0, 0))
    assert game.state.selection.required_captures == 2
    game.capture_to(index_of(0, 2))
    assert not game.can_end_turn()
    assert not game.end_turn().ok
    game.capture_to(index_of(0, 4))
    assert game.state.scores == [2, 0]


def test_โหมดหละหลวมหยุดกลาง_chain_ได้_และคะแนนตกเป็นของคู่แข่ง():
    game = chain_game(RuleMode.STANDARD)
    game.select(index_of(0, 0))
    assert game.state.selection.required_captures == 0
    assert game.state.selection.available_captures == 2

    game.capture_to(index_of(0, 2))
    assert game.state.current == 0, "ไม่จบเทิร์นอัตโนมัติ"
    assert game.can_end_turn()
    # คะแนนเข้าเมื่อจบเทิร์นเท่านั้น
    assert game.state.scores == [0, 0]
    assert game.end_turn().ok
    assert game.state.scores == [1, 0]
    assert game.state.history[0].missed_captures == 1

    # หมากที่ทิ้งไว้ตกเป็นของคู่แข่งได้ทันที
    assert game.select(index_of(0, 2)).ok
    assert game.capture_to(index_of(0, 4)).ok
    assert game.state.scores == [1, 1]


def test_โหมดหละหลวมเดินหมากเปล่าทั้งที่กินได้():
    game = chain_game(RuleMode.STANDARD)
    game.select(index_of(0, 0))
    assert game.state.selection.kind == "capture"
    assert game.move_to(index_of(1, 0)).ok

    record = game.state.history[0]
    assert game.state.scores == [0, 0]
    assert record.kind == "move"
    assert record.available_captures == 2
    assert record.missed_captures == 2


def test_โหมดหละหลวมยังตรวจความถูกกติกาทุกก้าว():
    game = chain_game(RuleMode.STANDARD)
    game.select(index_of(0, 0))
    assert not game.capture_to(index_of(0, 4)).ok, "ข้ามไปไกลเกินไป"
    assert not game.move_to(index_of(3, 3)).ok, "ไม่ติดกัน"
    assert game.state.scores == [0, 0]


def test_จับแล้วต้องเดินในโหมดกระดานจริง():
    table = chain_game(RuleMode.TABLE)
    assert table.select(index_of(0, 0)).ok
    result = table.clear_selection()
    assert not result.ok
    assert result.error.code == MakError.TOUCH_MOVE
    assert table.state.selection is not None

    assisted = chain_game(RuleMode.ASSISTED)
    assisted.select(index_of(0, 0))
    assert assisted.clear_selection().ok


def test_play_to_ตีความเองว่ากินหรือเดิน():
    game = chain_game(RuleMode.STANDARD)
    game.select(index_of(0, 0))
    assert game.play_to(index_of(0, 2)).ok
    assert game.state.selection.captures_so_far == 1
    game.end_turn()

    assert game.select(index_of(0, 3)).ok
    assert game.play_to(index_of(1, 4)).ok
    assert game.state.scores == [1, 0]


def test_บันทึกว่าตานั้นทั้งกระดานกินได้สูงสุดเท่าไร():
    game = game_with(
        ["oo......"] + [EMPTY_ROW] * 3 + ["oo.o.o.."] + [EMPTY_ROW] * 3, mode=RuleMode.STANDARD
    )
    game.select(index_of(0, 0))
    game.capture_to(index_of(0, 2))
    record = game.state.history[0]
    assert record.captures == 1
    assert record.best_available == 3, "มีทางกิน 3 อยู่แต่เลือกตัวที่กินได้ 1"


def test_สถิติสรุปโอกาสที่พลาด():
    game = chain_game(RuleMode.STANDARD)
    game.select(index_of(0, 0))
    game.move_to(index_of(1, 0))
    stats = game.match_stats()
    assert stats.players[0].missed_captures == 2
    assert stats.players[0].missed_turns == 1
    assert stats.players[0].worst_miss_turn == 1
    assert stats.players[1].missed_captures == 0
