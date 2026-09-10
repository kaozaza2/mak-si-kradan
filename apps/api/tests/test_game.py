from conftest import EMPTY_ROW, game_with
from makthai.domain import EndReason, winners_by_score
from makthai.games.mak_si_kradan import (
    Game,
    MakError,
    count_pieces,
    create_game_state,
    index_of,
)


def test_กินหนึ่งตัวได้หนึ่งคะแนนแล้วจบเทิร์น():
    game = game_with(["oo......"] + [EMPTY_ROW] * 7)
    assert game.select(index_of(0, 0)).ok
    assert game.capture_to(index_of(0, 2)).ok
    assert game.board[index_of(0, 0)] is None
    assert game.board[index_of(0, 1)] is None
    assert game.state.scores == [1, 0]
    assert game.state.current == 1


def test_กินต่อเนื่องได้สองคะแนนในเทิร์นเดียว():
    # ● ○ . ○ .
    game = game_with(["oo.o...."] + [EMPTY_ROW] * 7)
    assert game.select(index_of(0, 0)).ok
    assert game.state.selection.required_captures == 2
    assert game.capture_to(index_of(0, 2)).ok
    assert game.state.current == 0, "ยังไม่จบเทิร์น ต้องกินต่อ"
    assert game.capture_to(index_of(0, 4)).ok
    assert game.state.scores == [2, 0]
    assert game.state.history[0].path == (index_of(0, 0), index_of(0, 2), index_of(0, 4))


def test_เปลี่ยนทิศระหว่าง_chain_ได้():
    game = game_with(["oo......", ".o......"] + [EMPTY_ROW] * 6)
    game.select(index_of(0, 0))
    assert game.state.selection.required_captures == 2
    assert game.capture_to(index_of(0, 2)).ok
    assert game.capture_to(index_of(2, 0)).ok
    assert game.state.scores == [2, 0]


def test_หมากที่ถูกกินหายทันที_กินซ้ำไม่ได้():
    game = game_with(["oo.o...."] + [EMPTY_ROW] * 7)
    game.select(index_of(0, 0))
    game.capture_to(index_of(0, 2))
    assert game.board[index_of(0, 1)] is None
    game.capture_to(index_of(0, 4))
    assert count_pieces(game.board) == 1


def test_ก้าวที่พาไปสู่_chain_สั้นกว่าถูกปฏิเสธพร้อมบอกช่องที่ลงได้():
    game = game_with([EMPTY_ROW] * 3 + ["o.......", "oo.o.o.."] + [EMPTY_ROW] * 3)
    game.select(index_of(4, 0))
    rejected = game.capture_to(index_of(2, 0))
    assert not rejected.ok
    assert rejected.error.code == MakError.MUST_TAKE_MAXIMUM
    assert rejected.error.params["squares"] == ["c4"]


def test_หมากที่กินได้เดินปกติไม่ได้ในโหมดบังคับ():
    game = game_with(["oo......"] + [EMPTY_ROW] * 7)
    game.select(index_of(0, 0))
    result = game.move_to(index_of(1, 0))
    assert not result.ok
    assert result.error.code == MakError.MUST_CAPTURE


def test_หมากเป็นของกลาง_อีกฝ่ายหยิบตัวเดิมไปเล่นต่อได้():
    game = game_with(["oo.o...."] + [EMPTY_ROW] * 5 + ["oo......", EMPTY_ROW])
    game.select(index_of(6, 0))
    game.capture_to(index_of(6, 2))
    piece_id = game.state.history[0].piece_id
    assert game.state.current == 1
    assert game.board[index_of(6, 2)] == piece_id
    assert game.select(index_of(6, 2)).ok


def test_เดินปกติแล้วเปิดทางให้คู่แข่งกินจริง():
    game = game_with([EMPTY_ROW] * 3 + ["..o.....", "....o..."] + [EMPTY_ROW] * 3)
    game.select(index_of(3, 2))
    game.move_to(index_of(3, 3))
    assert game.state.current == 1
    assert game.select(index_of(3, 3)).ok
    assert game.capture_to(index_of(5, 5)).ok
    assert game.state.scores == [0, 1], "คะแนนตกเป็นของคู่แข่ง"


def test_จบเกมเมื่อไม่มีการกินติดต่อกันครบลิมิต():
    state = create_game_state(2, no_capture_limit=2)
    state.board = game_with([EMPTY_ROW] * 3 + ["...o...."] + [EMPTY_ROW] * 4).board
    game = Game(state)
    game.select(index_of(3, 3))
    game.move_to(index_of(2, 2))
    assert game.is_active
    game.select(index_of(2, 2))
    game.move_to(index_of(1, 1))
    assert not game.is_active
    assert game.state.result.reason is EndReason.EXHAUSTION


def test_ผู้ชนะคือคะแนนสูงสุด_เท่ากันคือชนะร่วม():
    assert winners_by_score([27, 23]) == (0,)
    assert winners_by_score([10, 10]) == (0, 1)
    # คนถอนตัวชนะไม่ได้แม้คะแนนนำ
    assert winners_by_score([50, 1, 2], retired=[0]) == (2,)


def test_เกม_4_คนวนเทิร์นครบทุกที่นั่ง():
    game = Game(create_game_state(4))
    seen = []
    for _ in range(8):
        seen.append(game.state.current)
        game.play_auto_turn()
    assert seen == [0, 1, 2, 3, 0, 1, 2, 3]


def test_คนถอนตัวถูกข้าม_ที่เหลือเล่นต่อ():
    game = Game(create_game_state(3))
    game.play_auto_turn()
    assert game.state.current == 1
    assert game.retire(1).ok
    assert game.is_active
    assert game.active_players() == [0, 2]
    assert game.state.current == 2
    game.play_auto_turn()
    assert game.state.current == 0


def test_เหลือคนเดียวเกมจบ():
    game = Game(create_game_state(3))
    game.state.scores = [50, 1, 2]
    game.retire(0)
    assert game.is_active
    game.retire(1)
    assert not game.is_active
    assert game.state.result.winners == (2,)


def test_เล่นอัตโนมัติจนจบ_คะแนนรวมเท่ากับหมากที่หายไป():
    game = Game()
    for _ in range(2000):
        if not game.is_active:
            break
        game.play_auto_turn()
    assert not game.is_active
    assert sum(game.state.scores) == 60 - count_pieces(game.board)
    stats = game.match_stats()
    assert stats.turns == len(game.state.history)
    assert stats.players[0].best_chain > 0
