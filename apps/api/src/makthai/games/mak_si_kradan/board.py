"""กระดาน 8x8 ที่มีช่องกลาง 4 ช่องว่างตั้งแต่เริ่ม

ช่องกลางต้องว่างตอนเริ่ม ไม่ใช่ห้ามลงถาวร ไม่งั้นกระดานจะเต็มตั้งแต่เทิร์นแรก
และไม่มีช่องให้กระโดดลงเลย เกมจะไม่มีการเล่นที่ถูกต้องตั้งแต่ต้น
"""

from __future__ import annotations

from dataclasses import dataclass

SIZE = 8
CELLS = SIZE * SIZE

#: ช่องกลาง 4 ช่อง — (3,3) (3,4) (4,3) (4,4) แบบนับจาก 0
CENTER_HOLES: tuple[int, ...] = (27, 28, 35, 36)

PIECE_COUNT = CELLS - len(CENTER_HOLES)

#: None = ช่องว่าง, int = id ของหมากที่อยู่บนช่องนั้น
Board = list[int | None]

FILES = "abcdefgh"


@dataclass(frozen=True, slots=True)
class Direction:
    dr: int
    dc: int
    glyph: str


#: 8 ทิศ — ทั้งแนวตั้ง แนวนอน และแนวทแยง
DIRECTIONS: tuple[Direction, ...] = (
    Direction(-1, 0, "↑"),
    Direction(1, 0, "↓"),
    Direction(0, -1, "←"),
    Direction(0, 1, "→"),
    Direction(-1, -1, "↖"),
    Direction(-1, 1, "↗"),
    Direction(1, -1, "↙"),
    Direction(1, 1, "↘"),
)


def index_of(row: int, col: int) -> int:
    return row * SIZE + col


def row_of(square: int) -> int:
    return square // SIZE


def col_of(square: int) -> int:
    return square % SIZE


def shift(square: int, direction: Direction, steps: int = 1) -> int:
    """เดินจากช่องหนึ่งไปตามทิศ คืน -1 เมื่อหลุดขอบกระดาน"""
    row = row_of(square) + direction.dr * steps
    col = col_of(square) + direction.dc * steps
    if not (0 <= row < SIZE and 0 <= col < SIZE):
        return -1
    return index_of(row, col)


def jumped_square(origin: int, landing: int) -> int:
    """ช่องที่ถูกข้ามระหว่างกระโดดจากช่องหนึ่งไปอีกช่อง"""
    return index_of(
        (row_of(origin) + row_of(landing)) // 2,
        (col_of(origin) + col_of(landing)) // 2,
    )


def initial_board() -> Board:
    """หมาก 60 ตัว เว้นช่องกลาง 4 ช่อง"""
    holes = set(CENTER_HOLES)
    board: Board = [None] * CELLS
    piece_id = 0
    for square in range(CELLS):
        if square not in holes:
            board[square] = piece_id
            piece_id += 1
    return board


def square_label(square: int) -> str:
    """ตำแหน่งแบบอ่านง่าย เช่น 12 -> 'e7'"""
    return f"{FILES[col_of(square)]}{SIZE - row_of(square)}"


def count_pieces(board: Board) -> int:
    return sum(1 for cell in board if cell is not None)


def find_piece(board: Board, piece_id: int) -> int:
    return board.index(piece_id) if piece_id in board else -1
