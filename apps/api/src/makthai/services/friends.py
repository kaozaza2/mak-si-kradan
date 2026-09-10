"""ระบบเพื่อน

ต้องมีตัวตนถาวรถึงจะใช้ได้ ผู้เล่นชั่วคราวจึงใช้ไม่ได้ — id ของเขาอยู่แค่ชั่วคราว
และไม่มีทางค้นหากันเจอ

ทุกฟังก์ชันคืนรหัส ไม่ใช่ข้อความ
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from makthai.db.models import Friendship, Player


@dataclass(frozen=True, slots=True)
class FriendResult:
    ok: bool
    #: pending เมื่อรอการตอบรับ, accepted เมื่อเป็นเพื่อนกันแล้ว
    status: str | None = None
    player: dict[str, Any] | None = None
    code: str | None = None

    @staticmethod
    def failure(code: str) -> FriendResult:
        return FriendResult(ok=False, code=code)


def summarize(player: Player) -> dict[str, Any]:
    return {
        "id": player.id,
        "name": player.name,
        "username": player.username,
        "rating": player.rating,
    }


class Friends:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _resolve(self, identifier: str) -> Player | None:
        value = identifier.strip()
        if not value:
            return None
        if "@" in value:
            return await self.session.scalar(select(Player).where(Player.email == value.lower()))
        by_username = await self.session.scalar(
            select(Player).where(Player.username == value.lower())
        )
        return by_username or await self.session.get(Player, value)

    async def _between(self, a: str, b: str) -> Friendship | None:
        return await self.session.scalar(
            select(Friendship).where(
                or_(
                    (Friendship.requester_id == a) & (Friendship.addressee_id == b),
                    (Friendship.requester_id == b) & (Friendship.addressee_id == a),
                )
            )
        )

    async def request(self, user_id: str, identifier: str) -> FriendResult:
        """ขอเป็นเพื่อน — ระบุด้วย id ชื่อผู้ใช้ หรืออีเมลก็ได้

        ถ้าอีกฝ่ายเคยส่งคำขอมาหาเราอยู่แล้ว ถือว่าตอบรับทันที เพราะทั้งสองฝ่าย
        แสดงเจตนาตรงกันแล้ว ไม่มีเหตุให้ต้องรออีกขั้น
        """
        target = await self._resolve(identifier)
        if target is None or target.kind != "user":
            return FriendResult.failure("player_not_found")
        if target.id == user_id:
            return FriendResult.failure("friend_self")

        existing = await self._between(user_id, target.id)
        if existing is not None:
            if existing.status == "accepted":
                return FriendResult.failure("already_friends")
            if existing.requester_id == user_id:
                return FriendResult.failure("friend_request_pending")
            existing.status = "accepted"
            existing.responded_at = datetime.now(UTC)
            await self.session.commit()
            return FriendResult(ok=True, status="accepted", player=summarize(target))

        self.session.add(Friendship(requester_id=user_id, addressee_id=target.id))
        await self.session.commit()
        return FriendResult(ok=True, status="pending", player=summarize(target))

    async def respond(self, user_id: str, request_id: int, accept: bool) -> FriendResult:
        row = await self.session.scalar(
            select(Friendship)
            .where(Friendship.id == request_id)
            .options(selectinload(Friendship.requester))
        )
        # ตอบได้เฉพาะคำขอที่ส่งมาหาเราและยังไม่ถูกตอบ
        if row is None or row.addressee_id != user_id or row.status != "pending":
            return FriendResult.failure("friend_request_gone")

        player = summarize(row.requester)
        if accept:
            row.status = "accepted"
            row.responded_at = datetime.now(UTC)
        else:
            await self.session.delete(row)
        await self.session.commit()
        return FriendResult(ok=True, status="accepted" if accept else "pending", player=player)

    async def remove(self, user_id: str, other_id: str) -> bool:
        row = await self._between(user_id, other_id)
        if row is None:
            return False
        await self.session.delete(row)
        await self.session.commit()
        return True

    async def ids(self, user_id: str) -> list[str]:
        rows = await self.session.scalars(
            select(Friendship).where(
                Friendship.status == "accepted",
                or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id),
            )
        )
        return [
            row.addressee_id if row.requester_id == user_id else row.requester_id
            for row in rows.all()
        ]

    async def listing(self, user_id: str) -> dict[str, list[dict[str, Any]]]:
        rows = await self.session.scalars(
            select(Friendship)
            .where(or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id))
            .options(
                selectinload(Friendship.requester),
                selectinload(Friendship.addressee),
            )
            .order_by(Friendship.created_at.desc())
        )

        friends: list[dict[str, Any]] = []
        incoming: list[dict[str, Any]] = []
        outgoing: list[dict[str, Any]] = []
        for row in rows.all():
            other = row.addressee if row.requester_id == user_id else row.requester
            if row.status == "accepted":
                friends.append(summarize(other))
            elif row.addressee_id == user_id:
                incoming.append({"requestId": row.id, "player": summarize(other)})
            else:
                outgoing.append({"requestId": row.id, "player": summarize(other)})

        friends.sort(key=lambda item: item["name"])
        return {"friends": friends, "incoming": incoming, "outgoing": outgoing}
