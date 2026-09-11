"""เครื่องสถานะของหนึ่งแมตช์

รองรับ 2–4 ผู้เล่น เพราะหมากเป็นของกลางอยู่แล้ว การเพิ่มผู้เล่นจึงเป็นแค่การเพิ่ม
คิวในลำดับเทิร์น ไม่ต้องแตะกติกาการกินเลย

กติกาปรับได้สองแกนที่ไม่เกี่ยวกัน: บังคับแค่ไหน กับช่วยชี้เป้าแค่ไหน การผ่อนสองอย่างนี้
คือสิ่งที่ทำให้ความผิดพลาดแบบกระดานจริงเกิดขึ้นได้ — ลืมกินต่อ กินไม่ครบ หรือหาจุดกิน
ไม่เจอจนเดินหมากเปล่าแทน ซึ่งไม่ต้องมีบทลงโทษ เพราะกระดานเป็นของกลาง คะแนนที่ไม่เก็บ
กลายเป็นของคู่แข่งทันที
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal

from makthai.domain.errors import ActionResult, CommonError
from makthai.domain.turnbased import TurnBasedEngine
from makthai.domain.types import EndReason, GameResult, PlayerIndex
from makthai.games.mak_si_kradan.board import (
    Board,
    count_pieces,
    initial_board,
    square_label,
)
from makthai.games.mak_si_kradan.rules import (
    CaptureStep,
    analyze_captures,
    capture_steps_from,
    has_any_legal_action,
    move_destinations,
    piece_options,
    selectable_squares,
)

MIN_PLAYERS = 2
MAX_PLAYERS = 4


class MakError(StrEnum):
    """รหัสข้อผิดพลาดเฉพาะกติกาของหมากสี่กระดาน"""

    MUST_FINISH_CHAIN = "must_finish_chain"
    EMPTY_SQUARE = "empty_square"
    PIECE_STUCK = "piece_stuck"
    ALREADY_ACTED = "already_acted"
    TOUCH_MOVE = "touch_move"
    NO_PIECE_SELECTED = "no_piece_selected"
    PIECE_CANNOT_CAPTURE = "piece_cannot_capture"
    NO_MORE_CAPTURES = "no_more_captures"
    MUST_TAKE_MAXIMUM = "must_take_maximum"
    ILLEGAL_JUMP = "illegal_jump"
    MUST_CAPTURE = "must_capture"
    ILLEGAL_MOVE = "illegal_move"
    NOTHING_PLAYED = "nothing_played"
    CHAIN_FORCED = "chain_forced"


#: จำนวนเทิร์นติดต่อกันที่ไม่มีการกิน ก่อนจะถือว่ากระดานตัน
#:
#: จำเป็นเพราะหมากตัวเดียวก็ยังเดินปกติได้เสมอ เงื่อนไข "ไม่มีการเล่นที่ถูกต้องเหลือ"
#: เพียงอย่างเดียวจึงแทบไม่มีทางเกิดขึ้น และเกมจะยืดไปได้ไม่รู้จบ
DEFAULT_NO_CAPTURE_LIMIT = 20


class AssistLevel(StrEnum):
    FULL = "full"
    PIECES = "pieces"
    NONE = "none"


class RuleMode(StrEnum):
    ASSISTED = "assisted"
    STANDARD = "standard"
    TABLE = "table"


@dataclass(frozen=True, slots=True)
class MatchRules:
    #: หมากที่กินได้ ต้องกิน ห้ามเดินปกติ
    force_capture: bool
    #: ต้องเดินเส้นทางที่กินได้มากที่สุด และกินจนสุด chain
    force_maximum: bool
    assist: AssistLevel
    #: จับหมากแล้วต้องเดินตัวนั้น เปลี่ยนใจไม่ได้
    touch_move: bool


RULE_PRESETS: dict[RuleMode, MatchRules] = {
    # ตามสเปกทุกข้อ เกมคำนวณให้หมด เหมาะกับคนเพิ่งหัดเล่น
    RuleMode.ASSISTED: MatchRules(True, True, AssistLevel.FULL, False),
    # บอกว่าหมากตัวไหนขยับได้ แต่ไม่บอกว่าไปไหนได้ และไม่บังคับให้กินจนสุด
    RuleMode.STANDARD: MatchRules(False, False, AssistLevel.PIECES, True),
    # ไม่ช่วยอะไรเลย เหมือนนั่งอยู่หน้ากระดานจริง
    RuleMode.TABLE: MatchRules(False, False, AssistLevel.NONE, True),
}


@dataclass(slots=True)
class Selection:
    piece_id: int
    origin: int
    at: int
    kind: Literal["capture", "move"]
    #: จำนวนที่ต้องกินให้ครบตามกติกา (0 = ไม่บังคับ)
    required_captures: int
    #: จำนวนที่หมากตัวนี้กินได้สูงสุด ไม่ว่าจะบังคับหรือไม่ — ใช้คิดว่าพลาดไปเท่าไร
    available_captures: int
    #: ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร ณ ตอนที่เลือกหมาก
    best_available: int
    captures_so_far: int = 0
    path: list[int] = field(default_factory=list)
    captured_squares: list[int] = field(default_factory=list)
    #: ลงมือไปแล้ว เปลี่ยนใจเลือกตัวอื่นไม่ได้
    locked: bool = False


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn: int
    player: PlayerIndex
    piece_id: int
    kind: Literal["capture", "move"]
    path: tuple[int, ...]
    captured_squares: tuple[int, ...]
    captures: int
    score_delta: int
    available_captures: int
    #: กินได้แต่ไม่ได้กิน = คะแนนที่ทิ้งไว้ให้คู่แข่งหยิบไปต่อ
    missed_captures: int
    #: ตานั้นทั้งกระดานกินได้สูงสุดเท่าไร (เลือกหมากถูกตัวหรือเปล่า)
    best_available: int


@dataclass(slots=True)
class PlayerStats:
    score: int = 0
    captures: int = 0
    turns: int = 0
    best_chain: int = 0
    best_chain_turn: int | None = None
    best_chain_path: tuple[int, ...] = ()
    missed_captures: int = 0
    missed_turns: int = 0
    worst_miss_turn: int | None = None
    worst_miss: int = 0
    retired: bool = False


@dataclass(slots=True)
class MatchStats:
    turns: int
    pieces_left: int
    players: list[PlayerStats]


@dataclass(slots=True)
class GameState:
    player_count: int
    rules: MatchRules
    board: Board
    scores: list[int]
    current: PlayerIndex
    #: ผู้เล่นที่ถอนตัวไปแล้ว — ข้ามในลำดับเทิร์นและชนะไม่ได้
    retired: list[PlayerIndex]
    turn: int
    selection: Selection | None
    status: Literal["active", "ended"]
    result: GameResult | None
    history: list[TurnRecord]
    no_capture_streak: int
    no_capture_limit: int


def create_game_state(
    player_count: int = MIN_PLAYERS,
    no_capture_limit: int = DEFAULT_NO_CAPTURE_LIMIT,
    rules: MatchRules | None = None,
) -> GameState:
    count = min(MAX_PLAYERS, max(MIN_PLAYERS, int(player_count)))
    return GameState(
        player_count=count,
        rules=rules or RULE_PRESETS[RuleMode.ASSISTED],
        board=initial_board(),
        scores=[0] * count,
        current=0,
        retired=[],
        turn=1,
        selection=None,
        status="active",
        result=None,
        history=[],
        no_capture_streak=0,
        no_capture_limit=no_capture_limit,
    )


class Game(TurnBasedEngine):
    """เครื่องสถานะของแมตช์ — ทุกการเปลี่ยนแปลงผ่านเมธอดในนี้เท่านั้น

    สืบทอด TurnBasedEngine เพื่อใช้ลำดับเทิร์น การถอนตัว และการจบเกมร่วมกับเกมอื่น
    ส่วนที่นั่ง คะแนน และสถานะถูกพร็อกซีเข้าไปเก็บใน GameState ที่เดียว จะได้ไม่มี
    ข้อมูลชุดเดียวกันอยู่สองที่แล้วหลุดจากกัน
    """

    def __init__(self, state: GameState | None = None) -> None:
        self.state = state or create_game_state()
        self._best_available_cache: tuple[int, int] | None = None

    @property
    def player_count(self) -> int:  # type: ignore[override]
        return self.state.player_count

    @property
    def scores(self) -> list[int]:
        return self.state.scores

    @scores.setter
    def scores(self, value: list[int]) -> None:
        self.state.scores = value

    @property
    def retired(self) -> list[PlayerIndex]:  # type: ignore[override]
        return self.state.retired

    @property
    def current(self) -> PlayerIndex:
        return self.state.current

    @current.setter
    def current(self, value: PlayerIndex) -> None:
        self.state.current = value

    @property
    def turn(self) -> int:
        return self.state.turn

    @turn.setter
    def turn(self, value: int) -> None:
        self.state.turn = value

    @property
    def status(self) -> str:
        return self.state.status

    @status.setter
    def status(self, value: str) -> None:
        self.state.status = value  # type: ignore[assignment]

    @property
    def result(self) -> GameResult | None:
        return self.state.result

    @result.setter
    def result(self, value: GameResult | None) -> None:
        self.state.result = value

    def on_current_player_retired(self) -> None:
        # ทิ้งหมากที่ค้างอยู่ในมือของคนที่เพิ่งถอนตัว
        self.state.selection = None

    def on_ending(self) -> None:
        self.state.selection = None

    # ── ข้อมูลอ่านอย่างเดียว ────────────────────────────────────────────────

    @property
    def board(self) -> Board:
        return self.state.board

    def selectable(self) -> list[int]:
        if not self.is_active:
            return []
        if self.state.selection is not None and self.state.selection.locked:
            return []
        return selectable_squares(self.state.board)

    def can_end_turn(self) -> bool:
        """ยังกินต่อได้แต่กติกาไม่บังคับ — ผู้เล่นเลือกหยุดเองได้"""
        selection = self.state.selection
        if selection is None or not selection.locked or not self.is_active:
            return False
        if self.state.rules.force_maximum:
            return False
        return bool(capture_steps_from(self.state.board, selection.at))

    def current_targets(self) -> tuple[Literal["capture", "move", "none"], list[int]]:
        selection = self.state.selection
        if selection is None or not self.is_active:
            return "none", []
        if selection.kind == "capture":
            return "capture", [s.landing for s in analyze_captures(self.board, selection.at).steps]
        return "move", move_destinations(self.board, selection.at)

    # ── การเล่น ─────────────────────────────────────────────────────────────

    def select(self, square: int) -> ActionResult:
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        if self.state.selection is not None and self.state.selection.locked:
            return ActionResult.fail(MakError.MUST_FINISH_CHAIN)
        if not (0 <= square < len(self.board)) or self.board[square] is None:
            return ActionResult.fail(MakError.EMPTY_SQUARE)

        options = piece_options(self.board, square)
        if options.kind == "none":
            return ActionResult.fail(MakError.PIECE_STUCK)

        available = options.max_captures if options.kind == "capture" else 0
        self.state.selection = Selection(
            piece_id=self.board[square],  # type: ignore[arg-type]
            origin=square,
            at=square,
            kind=options.kind,
            required_captures=available if self.state.rules.force_maximum else 0,
            available_captures=available,
            best_available=self._best_available(),
            path=[square],
        )
        return ActionResult.success()

    def clear_selection(self) -> ActionResult:
        selection = self.state.selection
        if selection is not None and selection.locked:
            return ActionResult.fail(MakError.ALREADY_ACTED)
        if selection is not None and self.state.rules.touch_move:
            return ActionResult.fail(MakError.TOUCH_MOVE)
        self.state.selection = None
        return ActionResult.success()

    def capture_to(self, landing: int) -> ActionResult:
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        selection = self.state.selection
        if selection is None:
            return ActionResult.fail(MakError.NO_PIECE_SELECTED)
        if selection.kind != "capture":
            return ActionResult.fail(MakError.PIECE_CANNOT_CAPTURE)

        # บังคับ Maximum Capture = เดินได้เฉพาะก้าวที่ยังพา chain ไปถึงค่าสูงสุด
        # ไม่บังคับ = กระโดดไปทางไหนก็ได้ที่ถูกกติกา แล้วจะหยุดตรงไหนก็เรื่องของผู้เล่น
        legal: tuple[CaptureStep, ...] | list[CaptureStep]
        if self.state.rules.force_maximum:
            legal = analyze_captures(self.board, selection.at).steps
        else:
            legal = capture_steps_from(self.board, selection.at)

        step = next((s for s in legal if s.landing == landing), None)
        if step is None:
            if not legal:
                return ActionResult.fail(MakError.NO_MORE_CAPTURES)
            squares = [square_label(s.landing) for s in legal]
            code = (
                MakError.MUST_TAKE_MAXIMUM
                if self.state.rules.force_maximum
                else MakError.ILLEGAL_JUMP
            )
            return ActionResult.fail(code, squares=squares)

        piece = self.board[selection.at]
        self.board[selection.at] = None
        self.board[step.over] = None
        self.board[step.landing] = piece

        selection.at = step.landing
        selection.captures_so_far += 1
        selection.path.append(step.landing)
        selection.captured_squares.append(step.over)
        selection.locked = True

        # กินต่อไม่ได้แล้วก็จบเทิร์นให้เลย ไม่มีอะไรให้ตัดสินใจต่อ
        if not capture_steps_from(self.board, selection.at):
            self._commit_turn()
        return ActionResult.success()

    def move_to(self, landing: int) -> ActionResult:
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        selection = self.state.selection
        if selection is None:
            return ActionResult.fail(MakError.NO_PIECE_SELECTED)
        if selection.locked:
            return ActionResult.fail(MakError.ALREADY_ACTED)
        if selection.kind != "move" and self.state.rules.force_capture:
            return ActionResult.fail(MakError.MUST_CAPTURE)
        if landing not in move_destinations(self.board, selection.at):
            return ActionResult.fail(MakError.ILLEGAL_MOVE)

        piece = self.board[selection.at]
        self.board[selection.at] = None
        self.board[landing] = piece

        selection.at = landing
        selection.path.append(landing)
        selection.locked = True
        self._commit_turn()
        return ActionResult.success()

    def play_to(self, landing: int) -> ActionResult:
        """วางหมากลงช่องหนึ่ง แล้วให้กติกาตีความเองว่าเป็นการกินหรือการเดิน

        ตรงกับกระดานจริงที่ผู้เล่นแค่วางหมากลง ไม่ได้ประกาศว่ากำลังทำอะไร
        และจำเป็นสำหรับโหมดที่ไม่ช่วยชี้เป้า เพราะ client ไม่ควรรู้ล่วงหน้าด้วยซ้ำ
        """
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        selection = self.state.selection
        if selection is None:
            return ActionResult.fail(MakError.NO_PIECE_SELECTED)
        is_jump = any(s.landing == landing for s in capture_steps_from(self.board, selection.at))
        return self.capture_to(landing) if is_jump else self.move_to(landing)

    def end_turn(self) -> ActionResult:
        """จบเทิร์นทั้งที่ยังกินต่อได้ — หัวใจของโหมดกระดานจริง"""
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        selection = self.state.selection
        if selection is None:
            return ActionResult.fail(MakError.NO_PIECE_SELECTED)
        if not selection.locked:
            return ActionResult.fail(MakError.NOTHING_PLAYED)
        if self.state.rules.force_maximum and capture_steps_from(self.board, selection.at):
            return ActionResult.fail(MakError.CHAIN_FORCED)
        self._commit_turn()
        return ActionResult.success()

    def play_auto_turn(self) -> ActionResult:
        """เล่นแทนผู้เล่นหนึ่งเทิร์น โดยหยิบหมากที่กินได้มากที่สุดแล้วไล่จนจบ"""
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)

        selection = self.state.selection
        if selection is None or not selection.locked:
            best_square, best_count = -1, -1
            for square in selectable_squares(self.board):
                options = piece_options(self.board, square)
                count = options.max_captures if options.kind == "capture" else 0
                if count > best_count:
                    best_square, best_count = square, count
            if best_square < 0:
                return ActionResult.fail(CommonError.NO_LEGAL_ACTION)
            self.state.selection = None
            picked = self.select(best_square)
            if not picked.ok:
                return picked

        while self.is_active and self.state.selection is not None:
            kind, targets = self.current_targets()
            if not targets:
                break
            if kind == "capture":
                self.capture_to(targets[0])
            else:
                self.move_to(targets[0])
        return ActionResult.success()

    def end_game(self, reason: EndReason) -> ActionResult:
        """ชื่อที่อ่านง่ายกว่าสำหรับ end() ของฐาน"""
        return self.end(reason)

    # ── ภายใน ───────────────────────────────────────────────────────────────

    def _best_available(self) -> int:
        """ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร — แคชต่อเทิร์นเพราะคลิกหลายครั้งได้"""
        if self._best_available_cache and self._best_available_cache[0] == self.state.turn:
            return self._best_available_cache[1]
        best = max(
            (
                analyze_captures(self.board, square).max_captures
                for square in selectable_squares(self.board)
            ),
            default=0,
        )
        self._best_available_cache = (self.state.turn, best)
        return best

    def _commit_turn(self) -> None:
        selection = self.state.selection
        assert selection is not None
        score_delta = selection.captures_so_far
        self.state.scores[self.state.current] += score_delta
        self.state.history.append(
            TurnRecord(
                turn=self.state.turn,
                player=self.state.current,
                piece_id=selection.piece_id,
                kind="capture" if score_delta > 0 else "move",
                path=tuple(selection.path),
                captured_squares=tuple(selection.captured_squares),
                captures=score_delta,
                score_delta=score_delta,
                available_captures=selection.available_captures,
                missed_captures=max(0, selection.available_captures - score_delta),
                best_available=selection.best_available,
            )
        )

        self.state.no_capture_streak = 0 if score_delta > 0 else self.state.no_capture_streak + 1
        self.state.selection = None
        # คะแนนบวกไปแล้วด้านบน ตรงนี้แค่ส่งเทิร์นต่อ
        self.advance_turn()

        if not has_any_legal_action(self.board):
            self.end_game(EndReason.NO_LEGAL_MOVES)
        elif self.state.no_capture_streak >= self.state.no_capture_limit:
            self.end_game(EndReason.EXHAUSTION)

    def stats(self) -> dict[str, Any]:
        """สรุปผลตอนจบเกม — รูปร่างเป็นของเกมนี้เอง แพลตฟอร์มแค่ส่งต่อ"""
        summary = compute_stats(self.state)
        return {
            "turns": summary.turns,
            "piecesLeft": summary.pieces_left,
            "players": [
                {
                    "score": p.score,
                    "captures": p.captures,
                    "turns": p.turns,
                    "bestChain": p.best_chain,
                    "bestChainTurn": p.best_chain_turn,
                    "bestChainPath": list(p.best_chain_path),
                    "missedCaptures": p.missed_captures,
                    "missedTurns": p.missed_turns,
                    "worstMiss": p.worst_miss,
                    "worstMissTurn": p.worst_miss_turn,
                    "retired": p.retired,
                }
                for p in summary.players
            ],
        }

    def match_stats(self) -> MatchStats:
        """สถิติแบบมีชนิดชัดเจน สำหรับใช้ในเทสต์และโค้ดฝั่ง Python"""
        return compute_stats(self.state)

    # ── สัญญากับแพลตฟอร์ม ───────────────────────────────────────────────────

    #: การกระทำที่รับได้ ผูกกับเมธอดที่ทำงานจริง
    _ACTIONS = ("select", "play", "capture", "move", "end_turn", "cancel_select")

    def apply(self, player: PlayerIndex, action: str, payload: dict[str, Any]) -> ActionResult:
        """ลงมือเล่นหนึ่งครั้ง — จุดเดียวที่แพลตฟอร์มเรียกเข้ามา"""
        if not self.is_active:
            return ActionResult.fail(CommonError.GAME_ENDED)
        if player != self.current:
            return ActionResult.fail(CommonError.NOT_YOUR_TURN)

        match action:
            case "select":
                return self.select(int(payload.get("square", -1)))
            case "play":
                return self.play_to(int(payload.get("to", -1)))
            case "capture":
                return self.capture_to(int(payload.get("to", -1)))
            case "move":
                return self.move_to(int(payload.get("to", -1)))
            case "end_turn":
                return self.end_turn()
            case "cancel_select":
                return self.clear_selection()
            case _:
                return ActionResult.fail(CommonError.UNKNOWN_ACTION, action=action)

    def view(self) -> dict[str, Any]:
        """สถานะที่ส่งให้ client วาด

        โหมดที่ไม่ช่วยชี้เป้าจะไม่ส่งข้อมูลช่วยเหลือออกไปเลย ไม่ใช่ให้ client เลือกไม่วาด
        ไม่งั้นเปิดเครื่องมือนักพัฒนาดูก็เห็นคำตอบหมด
        """
        rules = self.state.rules
        selection = self.state.selection
        target_kind, targets = self.current_targets()
        if rules.assist != AssistLevel.FULL:
            target_kind, targets = "none", []

        last = self.state.history[-1] if self.state.history else None
        return {
            "board": [-1 if cell is None else cell for cell in self.state.board],
            "playerCount": self.state.player_count,
            "scores": list(self.state.scores),
            "retired": list(self.state.retired),
            "current": self.state.current,
            "turn": self.state.turn,
            "status": self.state.status,
            "selection": None
            if selection is None
            else {
                "origin": selection.origin,
                "at": selection.at,
                "pieceId": selection.piece_id,
                "kind": selection.kind,
                "path": list(selection.path),
                "capturedSquares": list(selection.captured_squares),
                "requiredCaptures": selection.required_captures,
                "capturesSoFar": selection.captures_so_far,
                # จำนวนที่กินได้จริงเป็นคำใบ้ชั้นดี โหมดที่ไม่ช่วยจึงไม่บอก
                "availableCaptures": selection.available_captures
                if rules.assist == AssistLevel.FULL
                else None,
            },
            "selectable": [] if rules.assist == AssistLevel.NONE else self.selectable(),
            "targets": targets,
            "targetKind": target_kind,
            "canEndTurn": self.can_end_turn(),
            "rules": {
                "forceCapture": rules.force_capture,
                "forceMaximum": rules.force_maximum,
                "assist": rules.assist.value,
                "touchMove": rules.touch_move,
            },
            "lastTurn": None
            if last is None
            else {
                "turn": last.turn,
                "player": last.player,
                "pieceId": last.piece_id,
                "kind": last.kind,
                "path": list(last.path),
                "capturedSquares": list(last.captured_squares),
                "captures": last.captures,
                "missedCaptures": last.missed_captures,
                "bestAvailable": last.best_available,
            },
            "noCaptureStreak": self.state.no_capture_streak,
            "noCaptureLimit": self.state.no_capture_limit,
        }

    def auto_play_turn(self) -> ActionResult:
        return self.play_auto_turn()


def compute_stats(state: GameState) -> MatchStats:
    players = [PlayerStats(retired=i in state.retired) for i in range(state.player_count)]
    for i, player in enumerate(players):
        player.score = state.scores[i]

    for record in state.history:
        player = players[record.player]
        player.turns += 1
        player.captures += record.captures
        if record.captures > player.best_chain:
            player.best_chain = record.captures
            player.best_chain_turn = record.turn
            player.best_chain_path = record.path
        if record.missed_captures > 0:
            player.missed_captures += record.missed_captures
            player.missed_turns += 1
            if record.missed_captures > player.worst_miss:
                player.worst_miss = record.missed_captures
                player.worst_miss_turn = record.turn

    return MatchStats(
        turns=len(state.history),
        pieces_left=count_pieces(state.board),
        players=players,
    )
