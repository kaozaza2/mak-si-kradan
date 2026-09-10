from __future__ import annotations

from makthai.games.mak_si_kradan import (
    RULE_PRESETS,
    Board,
    Game,
    GameState,
    RuleMode,
    create_game_state,
    index_of,
)

EMPTY_ROW = "........"


def board_from_ascii(rows: list[str]) -> Board:
    """สร้างกระดานจากภาพ ASCII — 'o' คือหมาก '.' คือช่องว่าง"""
    assert len(rows) == 8, "ต้องมี 8 แถว"
    board: Board = [None] * 64
    piece_id = 0
    for r, row in enumerate(rows):
        assert len(row) == 8, f"แถว {r} ต้องมี 8 ช่อง"
        for c, symbol in enumerate(row):
            if symbol == "o":
                board[index_of(r, c)] = piece_id
                piece_id += 1
    return board


def game_with(rows: list[str], mode: RuleMode = RuleMode.ASSISTED, players: int = 2) -> Game:
    state: GameState = create_game_state(players, rules=RULE_PRESETS[mode])
    state.board = board_from_ascii(rows)
    return Game(state)
