from conftest import EMPTY_ROW, board_from_ascii
from makthai.games.mak_si_kradan import (
    analyze_captures,
    capture_steps_from,
    has_any_legal_action,
    index_of,
    initial_board,
    move_destinations,
    piece_options,
    selectable_squares,
)


def test_เปิดเกมมีการเล่นที่ถูกต้อง_ไม่ใช่กระดานตาย():
    board = initial_board()
    assert has_any_legal_action(board)
    selectable = selectable_squares(board)
    capturers = [s for s in selectable if piece_options(board, s).kind == "capture"]
    movers = [s for s in selectable if piece_options(board, s).kind == "move"]
    # ช่องกลาง 4 ช่องเปิดทางให้ 20 ตัวกระโดดลงไปกิน และ 12 ตัวรอบ ๆ ขยับลงไปได้
    assert len(selectable) == 32
    assert len(capturers) == 20
    assert len(movers) == 12


def test_เทิร์นแรกกินได้ไม่เกินหนึ่งตัว():
    board = initial_board()
    assert all(analyze_captures(board, s).max_captures <= 1 for s in selectable_squares(board))


def test_กินได้ครบ_8_ทิศ():
    board = board_from_ascii(
        [EMPTY_ROW, EMPTY_ROW, "..ooo...", "..ooo...", "..ooo...", EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]
    )
    steps = capture_steps_from(board, index_of(3, 3))
    assert len(steps) == 8
    assert {s.direction.glyph for s in steps} == {"↑", "↓", "←", "→", "↖", "↗", "↙", "↘"}


def test_กินไม่ได้เมื่อช่องปลายทางไม่ว่าง():
    board = board_from_ascii(
        [EMPTY_ROW, EMPTY_ROW, "..ooo...", "..ooo...", "..ooo...", EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]
    )
    assert analyze_captures(board, index_of(2, 2)).max_captures == 0
    assert piece_options(board, index_of(2, 2)).kind == "move"


def test_หมากโดดเดี่ยวเดินได้ทั้ง_8_ทิศ():
    board = board_from_ascii([EMPTY_ROW] * 3 + ["...o...."] + [EMPTY_ROW] * 4)
    assert len(move_destinations(board, index_of(3, 3))) == 8


def test_เส้นทางที่กินได้มากที่สุดเท่านั้นที่ถูกกติกา():
    # จาก (4,0): ขึ้นบนกินได้ 1 / ไปขวากินได้ 3
    board = board_from_ascii(
        [EMPTY_ROW, EMPTY_ROW, EMPTY_ROW, "o.......", "oo.o.o..", EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]
    )
    analysis = analyze_captures(board, index_of(4, 0))
    assert analysis.max_captures == 3
    assert [s.landing for s in analysis.steps] == [index_of(4, 2)]
