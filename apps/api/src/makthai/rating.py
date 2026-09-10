"""ระบบอันดับแบบ Elo

Elo ดั้งเดิมออกแบบมาสำหรับเกมสองคน แพลตฟอร์มนี้เล่นได้ถึงสี่คน จึงใช้วิธีมาตรฐาน
ของการขยายไปหลายคน คือแตกเป็นการเจอกันแบบคู่ทุกคู่แล้วเฉลี่ยด้วยจำนวนคู่ ผลลัพธ์คือ
ชนะคนเรตติ้งสูงได้แต้มเยอะกว่าชนะคนเรตติ้งต่ำ เหมือน Elo ปกติ

เป็นฟังก์ชันล้วน ไม่รู้จักฐานข้อมูล
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DEFAULT_RATING = 1200

Outcome = Literal["win", "loss", "draw"]


@dataclass(frozen=True, slots=True)
class RatingInput:
    rating: int
    #: คะแนนที่ทำได้ในแมตช์นั้น
    score: int
    #: ถอนตัวกลางคัน — ถือว่าแพ้ทุกคู่ ไม่ว่าคะแนนจะนำอยู่หรือไม่
    retired: bool
    games_played: int


@dataclass(frozen=True, slots=True)
class RatingChange:
    before: int
    after: int
    delta: int
    outcome: Outcome


def k_factor(rating: int, games_played: int) -> int:
    """ยิ่งเล่นน้อยยิ่งขยับเร็ว เพื่อให้เรตติ้งเข้าที่ไว
    และผู้เล่นเรตติ้งสูงขยับช้าลงเพื่อความเสถียรของหัวตาราง
    """
    if games_played < 30:
        return 32
    if rating >= 2000:
        return 16
    return 24


def expected_score(rating: int, opponent_rating: int) -> float:
    return 1 / (1 + 10 ** ((opponent_rating - rating) / 400))


def _pair_result(a: RatingInput, b: RatingInput) -> float:
    """ผลการเจอกันของคู่หนึ่ง — 1 ชนะ, 0.5 เสมอ, 0 แพ้"""
    # คนถอนตัวถือว่าแพ้เสมอ ยกเว้นเจอกันเองระหว่างคนที่ถอนตัวทั้งคู่
    if a.retired and not b.retired:
        return 0.0
    if b.retired and not a.retired:
        return 1.0
    if a.score > b.score:
        return 1.0
    if a.score < b.score:
        return 0.0
    return 0.5


def compute_changes(players: list[RatingInput]) -> list[RatingChange]:
    if len(players) < 2:
        return [
            RatingChange(before=p.rating, after=p.rating, delta=0, outcome="draw") for p in players
        ]

    changes: list[RatingChange] = []
    divisor = len(players) - 1
    for index, player in enumerate(players):
        actual = expected = 0.0
        wins = losses = 0
        for other_index, other in enumerate(players):
            if other_index == index:
                continue
            result = _pair_result(player, other)
            actual += result
            expected += expected_score(player.rating, other.rating)
            if result == 1.0:
                wins += 1
            elif result == 0.0:
                losses += 1

        delta = round(k_factor(player.rating, player.games_played) * (actual - expected) / divisor)
        outcome: Outcome = "win" if wins > losses else "loss" if losses > wins else "draw"
        changes.append(
            RatingChange(
                before=player.rating,
                after=player.rating + delta,
                delta=delta,
                outcome=outcome,
            )
        )
    return changes
