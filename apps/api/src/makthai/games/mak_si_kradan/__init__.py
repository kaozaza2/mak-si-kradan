"""หมากสี่กระดาน — เกมแรกของแพลตฟอร์ม

กระดาน 8x8 ที่หมากทุกตัวเป็นของกลาง ใครถึงเทิร์นก็หยิบตัวไหนก็ได้
สิ่งที่เป็นของผู้เล่นจริง ๆ มีอย่างเดียวคือคะแนนจากการกิน
"""

from __future__ import annotations

from makthai.domain.registry import GameDefinition, registry
from makthai.games.mak_si_kradan.ai import LEVELS as BOT_LEVELS
from makthai.games.mak_si_kradan.ai import MakBot, choose_move, create_bot
from makthai.games.mak_si_kradan.board import (
    CELLS,
    CENTER_HOLES,
    DIRECTIONS,
    FILES,
    PIECE_COUNT,
    SIZE,
    Board,
    Direction,
    col_of,
    count_pieces,
    find_piece,
    index_of,
    initial_board,
    jumped_square,
    row_of,
    shift,
    square_label,
)
from makthai.games.mak_si_kradan.engine import (
    DEFAULT_NO_CAPTURE_LIMIT,
    MAX_PLAYERS,
    MIN_PLAYERS,
    RULE_PRESETS,
    AssistLevel,
    Game,
    GameState,
    MakError,
    MatchRules,
    MatchStats,
    PlayerStats,
    RuleMode,
    Selection,
    TurnRecord,
    compute_stats,
    create_game_state,
)
from makthai.games.mak_si_kradan.rules import (
    CaptureAnalysis,
    CaptureStep,
    PieceOptions,
    analyze_captures,
    capture_steps_from,
    has_any_legal_action,
    move_destinations,
    piece_has_action,
    piece_options,
    selectable_squares,
)

GAME_ID = "mak-si-kradan"


def create(player_count: int = MIN_PLAYERS, mode: str = RuleMode.ASSISTED.value) -> Game:
    """สร้างแมตช์ใหม่ — เซ็นเจอร์นี้คือสิ่งที่ทะเบียนเกมเรียกใช้"""
    try:
        rule_mode = RuleMode(mode)
    except ValueError:
        rule_mode = RuleMode.ASSISTED
    return Game(create_game_state(player_count, rules=RULE_PRESETS[rule_mode]))


DEFINITION = registry.register(
    GameDefinition(
        id=GAME_ID,
        icon="⚫",
        min_players=MIN_PLAYERS,
        max_players=MAX_PLAYERS,
        default_turn_seconds=45,
        modes=tuple(mode.value for mode in RuleMode),
        create=create,
        bot_levels=BOT_LEVELS,
        create_bot=create_bot,
        options={"board": "8x8", "pieces": PIECE_COUNT},
    )
)

__all__ = [
    "BOT_LEVELS",
    "CELLS",
    "CENTER_HOLES",
    "DEFAULT_NO_CAPTURE_LIMIT",
    "DEFINITION",
    "DIRECTIONS",
    "FILES",
    "GAME_ID",
    "MAX_PLAYERS",
    "MIN_PLAYERS",
    "PIECE_COUNT",
    "RULE_PRESETS",
    "SIZE",
    "AssistLevel",
    "Board",
    "CaptureAnalysis",
    "CaptureStep",
    "Direction",
    "Game",
    "GameState",
    "MakBot",
    "MakError",
    "MatchRules",
    "MatchStats",
    "PieceOptions",
    "PlayerStats",
    "RuleMode",
    "Selection",
    "TurnRecord",
    "analyze_captures",
    "capture_steps_from",
    "choose_move",
    "col_of",
    "compute_stats",
    "count_pieces",
    "create",
    "create_bot",
    "create_game_state",
    "find_piece",
    "has_any_legal_action",
    "index_of",
    "initial_board",
    "jumped_square",
    "move_destinations",
    "piece_has_action",
    "piece_options",
    "row_of",
    "selectable_squares",
    "shift",
    "square_label",
]
