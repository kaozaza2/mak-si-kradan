"""กติกาการกินและการเดิน — ฟังก์ชันล้วน ไม่มี state ของตัวเอง

หลักการ:
  * หมากทุกตัวเป็นของกลาง ใครถึงเทิร์นเลือกตัวไหนก็ได้
  * กิน = กระโดดข้ามหมาก 1 ตัวไปยังช่องถัดไปที่ต้องว่าง ได้ทั้ง 8 ทิศ
  * กินต่อเนื่องได้และเปลี่ยนทิศระหว่างทางได้
  * ถ้าหมากที่เลือกกินไม่ได้ ก็ขยับ 1 ช่องใน 8 ทิศแทน
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from makthai.games.mak_si_kradan.board import DIRECTIONS, Board, Direction, shift

#: เพดานจำนวน node ของการค้นหา chain กันกระดานที่แตกแขนงมหาศาล
#: บนกระดาน 8x8 แทบไม่มีทางแตะเพดานนี้
SEARCH_NODE_BUDGET = 2_000_000


@dataclass(frozen=True, slots=True)
class CaptureStep:
    """การกระโดดกินหนึ่งก้าว"""

    origin: int
    over: int
    landing: int
    captured_piece: int
    direction: Direction


@dataclass(frozen=True, slots=True)
class CaptureAnalysis:
    #: จำนวนหมากสูงสุดที่หมากตัวนี้กินได้ใน 1 เทิร์น (0 = กินไม่ได้)
    max_captures: int
    #: ก้าวแรกที่ยังพา chain ไปถึงค่าสูงสุดได้เท่านั้น
    steps: tuple[CaptureStep, ...]


def capture_steps_from(board: Board, origin: int) -> list[CaptureStep]:
    """ก้าวการกินที่เป็นไปได้ทั้งหมดจากช่องหนึ่ง โดยยังไม่ดูว่า chain จะยาวแค่ไหน"""
    steps: list[CaptureStep] = []
    if board[origin] is None:
        return steps
    for direction in DIRECTIONS:
        over = shift(origin, direction, 1)
        if over < 0:
            continue
        landing = shift(origin, direction, 2)
        if landing < 0:
            continue
        captured = board[over]
        if captured is None or board[landing] is not None:
            continue
        steps.append(CaptureStep(origin, over, landing, captured, direction))
    return steps


def _search_max_chain(board: Board, origin: int, budget: list[int]) -> int:
    """ความยาว chain สูงสุดจากช่องหนึ่ง — แก้กระดานแล้วคืนค่าเดิมเพื่อไม่ต้อง copy"""
    piece = board[origin]
    if piece is None:
        return 0

    best = 0
    for direction in DIRECTIONS:
        if budget[0] <= 0:
            break
        over = shift(origin, direction, 1)
        if over < 0:
            continue
        landing = shift(origin, direction, 2)
        if landing < 0:
            continue
        captured = board[over]
        if captured is None or board[landing] is not None:
            continue

        budget[0] -= 1
        board[origin] = None
        board[over] = None
        board[landing] = piece
        depth = 1 + _search_max_chain(board, landing, budget)
        board[landing] = None
        board[over] = captured
        board[origin] = piece

        best = max(best, depth)
    return best


def analyze_captures(board: Board, origin: int) -> CaptureAnalysis:
    """หา chain ที่ยาวที่สุดของหมากตัวหนึ่ง พร้อมก้าวแรกที่ยังไปถึงความยาวนั้นได้

    กติกา Maximum Capture บังคับว่าต้องเดินก้าวที่ยังพาไปถึงค่าสูงสุดเท่านั้น
    """
    first = capture_steps_from(board, origin)
    if not first:
        return CaptureAnalysis(0, ())

    work = list(board)
    piece = work[origin]
    budget = [SEARCH_NODE_BUDGET]
    depths: list[int] = []

    for step in first:
        work[origin] = None
        work[step.over] = None
        work[step.landing] = piece
        depths.append(1 + _search_max_chain(work, step.landing, budget))
        work[step.landing] = None
        work[step.over] = step.captured_piece
        work[origin] = piece

    best = max(depths)
    return CaptureAnalysis(best, tuple(s for s, d in zip(first, depths, strict=True) if d == best))


def move_destinations(board: Board, origin: int) -> list[int]:
    """ช่องปลายทางของการเดินปกติ — 1 ช่อง 8 ทิศ ไปยังช่องที่ว่าง"""
    if board[origin] is None:
        return []
    destinations: list[int] = []
    for direction in DIRECTIONS:
        landing = shift(origin, direction, 1)
        if landing >= 0 and board[landing] is None:
            destinations.append(landing)
    return destinations


@dataclass(frozen=True, slots=True)
class PieceOptions:
    kind: Literal["capture", "move", "none"]
    max_captures: int = 0
    steps: tuple[CaptureStep, ...] = ()
    destinations: tuple[int, ...] = ()


def piece_options(board: Board, origin: int) -> PieceOptions:
    """สิ่งที่หมากตัวนี้ทำได้ — กินได้ก็ถือว่าเป็นตัวกิน ไม่งั้นก็เป็นตัวเดิน"""
    if not (0 <= origin < len(board)) or board[origin] is None:
        return PieceOptions("none")
    analysis = analyze_captures(board, origin)
    if analysis.max_captures > 0:
        return PieceOptions("capture", analysis.max_captures, analysis.steps)
    destinations = move_destinations(board, origin)
    if destinations:
        return PieceOptions("move", destinations=tuple(destinations))
    return PieceOptions("none")


def piece_has_action(board: Board, origin: int) -> bool:
    if board[origin] is None:
        return False
    return bool(move_destinations(board, origin)) or bool(capture_steps_from(board, origin))


def selectable_squares(board: Board) -> list[int]:
    """ทุกช่องที่หยิบมาเล่นได้ในเทิร์นนี้"""
    return [i for i in range(len(board)) if board[i] is not None and piece_has_action(board, i)]


def has_any_legal_action(board: Board) -> bool:
    return any(board[i] is not None and piece_has_action(board, i) for i in range(len(board)))
