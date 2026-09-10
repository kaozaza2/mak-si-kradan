"""ชนิดข้อมูลที่ทุกเกมในแพลตฟอร์มใช้ร่วมกัน"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

#: ที่นั่งของผู้เล่น นับจาก 0 ตามลำดับเทิร์น
PlayerIndex = int


class EndReason(StrEnum):
    """เหตุที่แมตช์จบ — เกมใหม่ใช้ชุดเดียวกันนี้ได้เลย"""

    NO_LEGAL_MOVES = "no_legal_moves"
    #: เล่นต่อได้แต่ไม่มีความคืบหน้า (เช่น ไม่มีการทำคะแนนติดต่อกันนาน)
    EXHAUSTION = "exhaustion"
    AGREEMENT = "agreement"
    RESIGN = "resign"
    TIMEOUT = "timeout"


@dataclass(frozen=True, slots=True)
class GameResult:
    reason: EndReason
    scores: tuple[int, ...]
    #: มากกว่า 1 คนคือเสมอกันที่คะแนนสูงสุด
    winners: tuple[PlayerIndex, ...]


def winners_by_score(
    scores: list[int] | tuple[int, ...], retired: list[int] | tuple[int, ...] = ()
) -> tuple[PlayerIndex, ...]:
    """ผู้ชนะคือคนคะแนนสูงสุดในบรรดาคนที่ยังไม่ถอนตัว"""
    eligible = [i for i in range(len(scores)) if i not in retired]
    if not eligible:
        return ()
    best = max(scores[i] for i in eligible)
    return tuple(i for i in eligible if scores[i] == best)
