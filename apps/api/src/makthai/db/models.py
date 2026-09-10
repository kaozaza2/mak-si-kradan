"""ตารางในฐานข้อมูล

เก็บสิ่งที่ควรอยู่ข้ามการรีสตาร์ต — ตัวตนผู้เล่น ผลการแข่ง และการเดินทุกเทิร์น
สำหรับ replay และการตรวจย้อนหลัง ส่วนแมตช์ที่กำลังเล่นอยู่ยังอยู่ในหน่วยความจำ
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from makthai.rating import DEFAULT_RATING


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Player(Base):
    """ผู้เล่นหนึ่งคน — guest มีแค่ id กับชื่อ ส่วน kind = user คือบัญชีที่สมัครไว้"""

    __tablename__ = "players"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16), default="guest")

    #: มีเฉพาะบัญชีที่สมัคร ใช้ล็อกอินได้เหมือนอีเมล
    username: Mapped[str | None] = mapped_column(String(32), unique=True, default=None)
    email: Mapped[str | None] = mapped_column(String(254), unique=True, default=None)
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    #: argon2id — ไม่เคยเก็บรหัสผ่านดิบ
    password_hash: Mapped[str | None] = mapped_column(Text, default=None)

    rating: Mapped[int] = mapped_column(Integer, default=DEFAULT_RATING)
    games_played: Mapped[int] = mapped_column(Integer, default=0)
    wins: Mapped[int] = mapped_column(Integer, default=0)
    losses: Mapped[int] = mapped_column(Integer, default=0)
    draws: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    seats: Mapped[list[MatchPlayer]] = relationship(back_populates="player")
    sent_requests: Mapped[list[Friendship]] = relationship(
        back_populates="requester", foreign_keys="Friendship.requester_id"
    )
    received_requests: Mapped[list[Friendship]] = relationship(
        back_populates="addressee", foreign_keys="Friendship.addressee_id"
    )

    __table_args__ = (Index("ix_players_ranking", "kind", "rating"),)

    @property
    def verified(self) -> bool:
        return self.email_verified_at is not None


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    game_id: Mapped[str] = mapped_column(String(64))
    #: ที่มาของแมตช์ — quick | room | ai
    source: Mapped[str] = mapped_column(String(16))
    mode: Mapped[str] = mapped_column(String(32))
    player_count: Mapped[int] = mapped_column(Integer)
    turn_seconds: Mapped[int] = mapped_column(Integer)
    turns: Mapped[int] = mapped_column(Integer, default=0)
    #: นับคะแนนอันดับหรือไม่
    ranked: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(16), default="active")
    reason: Mapped[str | None] = mapped_column(String(32), default=None)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    players: Mapped[list[MatchPlayer]] = relationship(
        back_populates="match", cascade="all, delete-orphan", order_by="MatchPlayer.seat"
    )
    actions: Mapped[list[MatchAction]] = relationship(
        back_populates="match", cascade="all, delete-orphan", order_by="MatchAction.turn"
    )

    __table_args__ = (Index("ix_matches_recent", "status", "started_at"),)


class MatchPlayer(Base):
    """หนึ่งที่นั่งในหนึ่งแมตช์

    เก็บชื่อ ณ เวลานั้นไว้ด้วย เพราะผู้เล่นเปลี่ยนชื่อได้ แต่ประวัติเก่าควรแสดง
    ชื่อที่ใช้ตอนนั้น
    """

    __tablename__ = "match_players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    match_id: Mapped[str] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"))
    player_id: Mapped[str | None] = mapped_column(
        ForeignKey("players.id", ondelete="SET NULL"), default=None
    )
    seat: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(64))
    is_bot: Mapped[bool] = mapped_column(default=False)
    bot_level: Mapped[str | None] = mapped_column(String(16), default=None)

    score: Mapped[int] = mapped_column(Integer, default=0)
    retired: Mapped[bool] = mapped_column(default=False)
    winner: Mapped[bool] = mapped_column(default=False)
    rating_before: Mapped[int | None] = mapped_column(Integer, default=None)
    rating_after: Mapped[int | None] = mapped_column(Integer, default=None)

    match: Mapped[Match] = relationship(back_populates="players")
    player: Mapped[Player | None] = relationship(back_populates="seats")

    __table_args__ = (
        UniqueConstraint("match_id", "seat", name="uq_match_seat"),
        Index("ix_match_players_player", "player_id"),
    )


class MatchAction(Base):
    """หนึ่งเทิร์นที่เล่นไปแล้ว — พอที่จะเล่นซ้ำทั้งเกมได้จากกระดานเริ่มต้น"""

    __tablename__ = "match_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    match_id: Mapped[str] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"))
    turn: Mapped[int] = mapped_column(Integer)
    seat: Mapped[int] = mapped_column(Integer)
    #: รายละเอียดของเทิร์นเป็น JSON เพราะรูปร่างเป็นของแต่ละเกม
    detail: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    match: Mapped[Match] = relationship(back_populates="actions")

    __table_args__ = (UniqueConstraint("match_id", "turn", name="uq_match_turn"),)


class Friendship(Base):
    """ความเป็นเพื่อนหนึ่งคู่ เก็บแถวเดียวไม่ว่าจะมองจากฝั่งไหน

    ทิศทางบอกว่าใครเป็นคนขอ ซึ่งจำเป็นตอนที่คำขอยังไม่ถูกตอบรับ
    """

    __tablename__ = "friendships"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requester_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"))
    addressee_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"))
    #: pending | accepted
    status: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    requester: Mapped[Player] = relationship(
        back_populates="sent_requests", foreign_keys=[requester_id]
    )
    addressee: Mapped[Player] = relationship(
        back_populates="received_requests", foreign_keys=[addressee_id]
    )

    __table_args__ = (
        UniqueConstraint("requester_id", "addressee_id", name="uq_friend_pair"),
        Index("ix_friendships_addressee", "addressee_id", "status"),
    )
