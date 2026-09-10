from makthai.games.mak_si_kradan import (
    CENTER_HOLES,
    PIECE_COUNT,
    count_pieces,
    index_of,
    initial_board,
    square_label,
)
from makthai.games.mak_si_kradan.board import DIRECTIONS, jumped_square, shift


def test_กระดานเริ่มต้นมีหมาก_60_ตัวและช่องกลางว่าง():
    board = initial_board()
    assert count_pieces(board) == 60 == PIECE_COUNT
    assert all(board[hole] is None for hole in CENTER_HOLES)


def test_ป้ายตำแหน่งอ่านง่าย():
    assert square_label(0) == "a8"
    assert square_label(63) == "h1"
    assert square_label(index_of(4, 4)) == "e4"


def test_เดินหลุดขอบกระดานคืนค่าติดลบ():
    up = next(d for d in DIRECTIONS if d.glyph == "↑")
    assert shift(index_of(0, 0), up) == -1
    assert shift(index_of(1, 0), up) == index_of(0, 0)


def test_หาช่องที่ถูกข้ามได้ทุกทิศ():
    assert jumped_square(index_of(4, 4), index_of(4, 6)) == index_of(4, 5)
    assert jumped_square(index_of(4, 4), index_of(2, 2)) == index_of(3, 3)
    assert jumped_square(index_of(4, 4), index_of(6, 6)) == index_of(5, 5)
