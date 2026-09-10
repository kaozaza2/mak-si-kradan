"""แคตตาล็อกข้อความ

โปรโตคอลส่งแค่รหัสกับค่าประกอบ ตัวข้อความไม่ได้อยู่ใน packet เลย
client จะแปลเองก็ได้ หรือจะดึงแคตตาล็อกนี้ไปใช้ก็ได้ผ่าน GET /api/v1/messages

ข้อดีคือแอปมือถือเลือกภาษาเองได้ client เช็คข้อผิดพลาดด้วยรหัสแทนการเทียบสตริง
และแก้คำพูดได้โดยไม่ทำให้ client ที่ปล่อยไปแล้วพัง
"""

from __future__ import annotations

import re
from typing import Any

Locale = str
LOCALES: tuple[Locale, ...] = ("th", "en")
DEFAULT_LOCALE: Locale = "th"

_PLACEHOLDER = re.compile(r"\{(\w+)\}")

#: `{name}` คือที่เติมค่าจากพารามิเตอร์
MESSAGES: dict[str, dict[Locale, str]] = {
    # ── เกมในแพลตฟอร์ม ─────────────────────────────────────────────────────
    "game_mak-si-kradan": {"th": "หมากสี่กระดาน", "en": "Mak Si Kradan"},
    "tagline_mak-si-kradan": {
        "th": "หมากเดียวกัน ใครก็ใช้ได้ แต่คะแนนเป็นของคนกิน",
        "en": "Shared pieces, anyone can move them — but captures are yours alone",
    },
    # ── ข้อผิดพลาดที่ใช้ร่วมกันทุกเกม ──────────────────────────────────────
    "game_ended": {"th": "เกมจบแล้ว", "en": "The game has ended"},
    "not_your_turn": {"th": "ยังไม่ถึงตาคุณ", "en": "It is not your turn"},
    "unknown_player": {"th": "ไม่มีผู้เล่นคนนี้", "en": "No such player"},
    "already_retired": {"th": "ผู้เล่นคนนี้ถอนตัวไปแล้ว", "en": "That player already withdrew"},
    "unknown_action": {"th": "ไม่รู้จักคำสั่ง {action}", "en": "Unknown action {action}"},
    "no_legal_action": {"th": "ไม่มีการเล่นที่ถูกต้อง", "en": "No legal action available"},
    # ── กติกาของหมากสี่กระดาน ──────────────────────────────────────────────
    "must_finish_chain": {"th": "ต้องกินต่อให้จบ chain ก่อน", "en": "Finish the capture chain first"},
    "empty_square": {"th": "ช่องนี้ไม่มีหมาก", "en": "That square is empty"},
    "piece_stuck": {
        "th": "หมากตัวนี้กินไม่ได้และขยับไม่ได้",
        "en": "That piece can neither capture nor move",
    },
    "already_acted": {"th": "ลงมือไปแล้วในเทิร์นนี้", "en": "You have already acted this turn"},
    "touch_move": {
        "th": "จับหมากแล้วต้องเดินตัวนี้",
        "en": "Touch-move: you must play the piece you picked up",
    },
    "no_piece_selected": {"th": "ยังไม่ได้เลือกหมาก", "en": "No piece selected"},
    "piece_cannot_capture": {"th": "หมากตัวนี้กินไม่ได้", "en": "That piece cannot capture"},
    "no_more_captures": {"th": "ไม่มีการกินต่อจากตำแหน่งนี้", "en": "No further captures from here"},
    "must_take_maximum": {
        "th": "ต้องเลือกเส้นทางที่กินได้มากที่สุด (ลงได้ที่ {squares})",
        "en": "You must take the longest capture chain (playable: {squares})",
    },
    "illegal_jump": {
        "th": "กระโดดไปช่องนั้นไม่ได้ (ลงได้ที่ {squares})",
        "en": "Illegal jump (playable: {squares})",
    },
    "must_capture": {"th": "หมากตัวนี้กินได้ จึงต้องกิน", "en": "That piece can capture, so it must"},
    "illegal_move": {"th": "เดินไปช่องนั้นไม่ได้", "en": "That move is not legal"},
    "nothing_played": {
        "th": "ยังไม่ได้เดินอะไรเลยในเทิร์นนี้",
        "en": "You have not played anything yet",
    },
    "chain_forced": {
        "th": "โหมดนี้บังคับให้กินต่อจนสุด chain",
        "en": "This mode forces you to finish the chain",
    },
}


def resolve_locale(value: object) -> Locale:
    return value if value in LOCALES else DEFAULT_LOCALE


def render(code: str, params: dict[str, Any] | None = None, locale: Locale = DEFAULT_LOCALE) -> str:
    """เติมค่าลงในข้อความ ใช้ทั้งฝั่ง server (log) และ client ที่ดึงแคตตาล็อกไปใช้"""
    values = params or {}
    translations = MESSAGES.get(code)
    if translations is None:
        return code
    template = translations.get(locale) or translations[DEFAULT_LOCALE]

    def substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            return match.group(0)
        value = values[key]
        return (
            ", ".join(str(item) for item in value)
            if isinstance(value, list | tuple)
            else str(value)
        )

    return _PLACEHOLDER.sub(substitute, template)


def catalog_for(locale: Locale) -> dict[str, str]:
    """แคตตาล็อกของภาษาเดียว สำหรับส่งให้ client ไปใช้"""
    return {
        code: translations.get(locale, translations[DEFAULT_LOCALE])
        for code, translations in MESSAGES.items()
    }
