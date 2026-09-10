"""บอทของหมากสี่กระดาน

เกมนี้เป็นการแข่งสะสมคะแนน ไม่ใช่การยึดพื้นที่ การประเมินจึงคิดจาก "ผลต่างจำนวนที่กิน"
ตรง ๆ ด้วย negamax + alpha-beta

สิ่งที่ได้ผลจริงจากการให้บอทเล่นกันเองคือ **การประเมินภัยคุกคามที่ปลายการค้นหา**
ไม่ใช่ความลึก การเพิ่มเป็น 4 ply กลับแพ้ 2 ply เพราะท่าเดินเปล่ามีเป็นร้อยท่า
การตัดกิ่งให้แคบพอจะค้นลึกได้จึงมองข้ามท่าที่ปลอดภัยจริง ๆ ไป ส่วนรุ่นที่เติมค่า
"ปลายทางแล้วอีกฝ่ายยังกินต่อได้อีกเท่าไร" ชนะรุ่นที่ไม่มีถึง 11 จาก 12 เกม
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from typing import Any, Literal

from makthai.domain.bots import BotAction
from makthai.domain.turnbased import TurnBasedEngine
from makthai.games.mak_si_kradan.board import Board, jumped_square
from makthai.games.mak_si_kradan.engine import Game
from makthai.games.mak_si_kradan.rules import (
    analyze_captures,
    move_destinations,
    selectable_squares,
)

LEVELS = ("easy", "normal", "hard")
DEFAULT_LEVEL = "normal"


@dataclass(frozen=True, slots=True)
class Move:
    origin: int
    kind: Literal["capture", "move"]
    #: ช่องที่ลงในแต่ละก้าว ไม่รวมช่องเริ่มต้น
    path: tuple[int, ...]

    @property
    def captures(self) -> int:
        return len(self.path) if self.kind == "capture" else 0


@dataclass(frozen=True, slots=True)
class LevelConfig:
    depth: int
    root_width: int
    width: int
    chains_per_piece: int
    #: น้ำหนักของภัยคุกคามที่ปลายการค้นหา
    threat_weight: float
    time_budget: float
    #: โอกาสที่บอทจะ "ลืมกินต่อ" ในโหมดที่ไม่บังคับ
    miss_rate: float


CONFIGS: dict[str, LevelConfig] = {
    "easy": LevelConfig(0, 999, 0, 1, 0.0, 0.05, 0.35),
    "normal": LevelConfig(2, 16, 8, 2, 0.0, 0.4, 0.15),
    # ตัวคิดภัยคุกคามที่ปลายทางแพงที่สุด จึงคุมความกว้างไว้ไม่ให้ใบเยอะเกิน
    "hard": LevelConfig(2, 40, 10, 2, 0.5, 0.5, 0.04),
}


def max_capture_chains(board: Board, origin: int, limit: int = 3) -> list[tuple[int, ...]]:
    """เส้นทางการกินที่ยาวที่สุดทั้งหมดของหมากตัวหนึ่ง

    ทุกเส้นทางกินได้เท่ากันตามกติกา แต่หมากไปจบคนละที่ ซึ่งสำคัญมากในเกมนี้
    เพราะตำแหน่งปลายทางคืออาวุธที่ส่งต่อให้คู่แข่ง
    """
    analysis = analyze_captures(board, origin)
    if analysis.max_captures == 0 or limit <= 0:
        return []

    paths: list[tuple[int, ...]] = []
    for step in analysis.steps:
        nxt = list(board)
        piece = nxt[origin]
        nxt[origin] = None
        nxt[step.over] = None
        nxt[step.landing] = piece

        tails = max_capture_chains(nxt, step.landing, limit - len(paths))
        if not tails:
            paths.append((step.landing,))
        else:
            for tail in tails:
                paths.append((step.landing, *tail))
                if len(paths) >= limit:
                    break
        if len(paths) >= limit:
            break
    return paths


def generate_moves(board: Board, chains_per_piece: int = 3) -> list[Move]:
    """ท่าที่ถูกกติกาทั้งหมด — หมากเป็นของกลาง จึงเป็นท่าของฝ่ายที่ถึงตาเสมอ"""
    moves: list[Move] = []
    for origin in selectable_squares(board):
        chains = max_capture_chains(board, origin, chains_per_piece)
        if chains:
            moves.extend(Move(origin, "capture", path) for path in chains)
            continue
        moves.extend(
            Move(origin, "move", (landing,)) for landing in move_destinations(board, origin)
        )
    return moves


def apply_move(board: Board, move: Move) -> Board:
    nxt = list(board)
    piece = nxt[move.origin]
    at = move.origin
    for landing in move.path:
        if move.kind == "capture":
            nxt[jumped_square(at, landing)] = None
        nxt[at] = None
        nxt[landing] = piece
        at = landing
    return nxt


def best_immediate_capture(board: Board) -> int:
    """จำนวนที่ฝ่ายถึงตากินได้ทันที ใช้เป็นค่าประเมินที่ปลายการค้นหา"""
    return max(
        (analyze_captures(board, origin).max_captures for origin in selectable_squares(board)),
        default=0,
    )


def _search(
    board: Board, depth: int, alpha: float, beta: float, config: LevelConfig, deadline: float
) -> float:
    if depth <= 0 or time.monotonic() > deadline:
        return config.threat_weight * best_immediate_capture(board) if config.threat_weight else 0.0

    moves = sorted(generate_moves(board, config.chains_per_piece), key=lambda m: -m.captures)
    moves = moves[: config.width]
    if not moves:
        return 0.0

    best = float("-inf")
    for move in moves:
        value = move.captures - _search(
            apply_move(board, move), depth - 1, -beta, -alpha, config, deadline
        )
        best = max(best, value)
        alpha = max(alpha, best)
        if alpha >= beta or time.monotonic() > deadline:
            break
    return 0.0 if best == float("-inf") else best


def choose_move(
    board: Board, level: str = DEFAULT_LEVEL, rng: random.Random | None = None
) -> Move | None:
    """เลือกท่าที่จะเล่น — คืน None เมื่อไม่มีท่าที่เล่นได้"""
    chooser = rng or random
    config = CONFIGS.get(level, CONFIGS[DEFAULT_LEVEL])
    moves = generate_moves(board, config.chains_per_piece)
    if not moves:
        return None

    if config.depth == 0:
        return _pick_greedy(moves, chooser, config.miss_rate)

    deadline = time.monotonic() + config.time_budget
    candidates = sorted(moves, key=lambda m: -m.captures)[: config.root_width]

    best_value = float("-inf")
    best: list[Move] = []
    for move in candidates:
        value = move.captures - _search(
            apply_move(board, move), config.depth - 1, float("-inf"), float("inf"), config, deadline
        )
        if value > best_value + 1e-9:
            best_value, best = value, [move]
        elif abs(value - best_value) < 1e-9:
            best.append(move)

    # ท่าที่ดีเท่ากันให้สุ่ม เพื่อไม่ให้บอทเล่นซ้ำรูปเดิมทุกเกม
    return chooser.choice(best) if best else candidates[0]


def _pick_greedy(moves: list[Move], chooser: random.Random | Any, miss_rate: float) -> Move:
    """มองเห็นการกินตรงหน้าเป็นส่วนใหญ่ แต่ไม่คิดต่อว่าจะเปิดทางให้คู่แข่งหรือเปล่า"""
    capturing = [m for m in moves if m.captures > 0]
    if capturing and chooser.random() > miss_rate:
        best_count = max(m.captures for m in capturing)
        return chooser.choice([m for m in capturing if m.captures == best_count])
    return chooser.choice(moves)


class MakBot:
    """บอทที่ทำตามสัญญา BotPlayer ของแพลตฟอร์ม"""

    def __init__(self, level: str = DEFAULT_LEVEL, rng: random.Random | None = None) -> None:
        self.level = level if level in CONFIGS else DEFAULT_LEVEL
        self._rng = rng or random.Random()

    def plan_turn(self, engine: TurnBasedEngine) -> list[BotAction]:
        assert isinstance(engine, Game)
        move = choose_move(engine.board, self.level, self._rng)
        if move is None:
            return []

        path = self._with_human_error(move, engine)
        actions: list[BotAction] = [("select", {"square": move.origin})]
        actions.extend(("play", {"to": landing}) for landing in path)
        # หยุดกลาง chain ได้เฉพาะโหมดที่ไม่บังคับ ต้องปิดเทิร์นเองด้วย
        if move.kind == "capture" and len(path) < len(move.path):
            actions.append(("end_turn", {}))
        return actions

    def _with_human_error(self, move: Move, engine: Game) -> tuple[int, ...]:
        """ในโหมดที่ไม่บังคับ บอทก็ควรลืมกินต่อได้เหมือนคน

        ไม่งั้นบอทจะได้เปรียบเชิงระบบทันที เพราะมันไม่มีวันมองข้ามอะไรเลย
        """
        if engine.state.rules.force_maximum or move.kind != "capture" or len(move.path) < 2:
            return move.path
        if self._rng.random() >= CONFIGS[self.level].miss_rate:
            return move.path
        return move.path[: self._rng.randint(1, len(move.path) - 1)]


def create_bot(level: str = DEFAULT_LEVEL) -> MakBot:
    return MakBot(level)
