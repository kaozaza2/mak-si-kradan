"""บอทของหมากสี่กระดาน"""

import random

from conftest import EMPTY_ROW, board_from_ascii, game_with
from makthai.games.mak_si_kradan import Game, RuleMode, create_bot, index_of
from makthai.games.mak_si_kradan.ai import (
    apply_move,
    best_immediate_capture,
    choose_move,
    generate_moves,
    max_capture_chains,
)
from makthai.games.mak_si_kradan.board import count_pieces, initial_board


def play_turn(game: Game, bot) -> bool:
    actions = bot.plan_turn(game)
    if not actions:
        return False
    for action, payload in actions:
        assert game.apply(game.current, action, payload).ok, f"บอทสั่ง {action} ที่ผิดกติกา"
    return True


def test_ท่าที่บอทสร้างทั้งหมดเดินได้จริงบนกระดานเปิดเกม():
    board = initial_board()
    moves = generate_moves(board)
    assert moves
    for move in moves:
        game = Game()
        assert game.select(move.origin).ok
        for landing in move.path:
            assert game.play_to(landing).ok


def test_เส้นทางกินยาวที่สุดเท่านั้นที่ถูกเลือก():
    # จาก (4,0): ขึ้นบนกินได้ 1 / ไปขวากินได้ 3
    board = board_from_ascii([EMPTY_ROW] * 3 + ["o.......", "oo.o.o.."] + [EMPTY_ROW] * 3)
    chains = max_capture_chains(board, index_of(4, 0))
    assert chains
    assert all(len(chain) == 3 for chain in chains)
    assert chains[0] == (index_of(4, 2), index_of(4, 4), index_of(4, 6))


def test_จำลองกระดานหลังเดินตรงกับที่เกมเดินจริง():
    game = Game()
    move = next(m for m in generate_moves(game.board) if m.captures > 0)
    predicted = apply_move(game.board, move)

    game.select(move.origin)
    for landing in move.path:
        game.play_to(landing)
    assert game.board == predicted
    assert count_pieces(predicted) == 60 - move.captures


def test_เลือกหมากที่กินได้มากที่สุดของทั้งกระดาน_ไม่ใช่ตัวแรกที่เจอ():
    game = game_with([EMPTY_ROW] * 3 + ["o.......", "oo.o.o.."] + [EMPTY_ROW] * 3)
    # หมากที่ a5 ซิกแซกได้ 4 ส่วน a4 กินตรงได้ 3
    best = max(m.captures for m in generate_moves(game.board))
    for level in ("normal", "hard"):
        move = choose_move(game.board, level, random.Random(1))
        assert move is not None
        assert move.captures == best


def test_บอกจำนวนที่กินได้ทันทีของกระดาน():
    assert best_immediate_capture(initial_board()) == 1
    assert best_immediate_capture([None] * 64) == 0


def test_ทุกระดับเล่นได้ถูกกติกาตลอดเกม():
    for level in ("easy", "normal", "hard"):
        game, bot = Game(), create_bot(level)
        for _ in range(60):
            if not game.is_active or not play_turn(game, bot):
                break
        assert game.turn > 10, f"ระดับ {level} เล่นไปได้ไม่กี่ตา"


def test_ระดับยากชนะระดับง่าย():
    wins = 0
    for seed in range(4):
        game = Game()
        bots = {0: create_bot("hard"), 1: create_bot("easy")}
        random.seed(seed)
        for _ in range(300):
            if not game.is_active or not play_turn(game, bots[game.current]):
                break
        if game.scores[0] > game.scores[1]:
            wins += 1
    assert wins >= 3


def test_ในโหมดหละหลวมบอทลืมกินต่อได้เหมือนคน():
    """ไม่งั้นบอทได้เปรียบเชิงระบบ เพราะไม่มีวันมองข้ามอะไรเลย"""
    stopped_early = False
    for seed in range(60):
        game = game_with(["oo.o...."] + [EMPTY_ROW] * 7, mode=RuleMode.STANDARD)
        bot = create_bot("easy")
        bot._rng = random.Random(seed)
        actions = bot.plan_turn(game)
        if any(action == "end_turn" for action, _ in actions):
            stopped_early = True
            break
    assert stopped_early, "บอทไม่เคยหยุดกลาง chain เลยแม้แต่ครั้งเดียว"


def test_ในโหมดบังคับบอทไม่หยุดกลาง_chain():
    for seed in range(30):
        game = game_with(["oo.o...."] + [EMPTY_ROW] * 7, mode=RuleMode.ASSISTED)
        bot = create_bot("easy")
        bot._rng = random.Random(seed)
        assert all(action != "end_turn" for action, _ in bot.plan_turn(game))


def test_ไม่มีท่าให้เล่นก็คืนแผนว่าง():
    game = Game()
    game.state.board = [None] * 64
    assert create_bot("hard").plan_turn(game) == []
