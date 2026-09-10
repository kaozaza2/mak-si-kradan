"""ศูนย์กลางของการเล่นออนไลน์

รวมทุกอย่างที่ไม่ใช่กติกาเกม — ตัวตน ห้อง การจับคู่ นาฬิกา บอท และการกระจายข้อความ
แต่ไม่ผูกกับ WebSocket ตัว transport อยู่ใน ws.py และคุยกับที่นี่ผ่าน Connection

hub ไม่รู้จักกติกาของเกมใดเลย ทุกการเล่นถูกส่งต่อไปให้ engine ตัดสิน
เกมใหม่ที่ลงทะเบียนไว้จึงเล่นออนไลน์ได้ทันทีโดยไม่ต้องแก้ไฟล์นี้
"""

from __future__ import annotations

import random
import time
import uuid
from typing import Any, Protocol

from makthai.auth import (
    Identity,
    new_guest_id,
    new_guest_name,
    room_code,
    sanitize_name,
    sign_token,
    verify_token,
)
from makthai.domain.registry import GameRegistry
from makthai.domain.types import EndReason
from makthai.realtime.cluster import (
    PEER_TIMEOUT,
    SNAPSHOT_INTERVAL,
    Cluster,
    RemoteConnection,
    Snapshot,
)
from makthai.realtime.match import Match
from makthai.realtime.room import Room
from makthai.realtime.scheduler import AsyncioScheduler, Scheduler
from makthai.realtime.session import Connection, Session

PROTOCOL_VERSION = 1


class MatchSink(Protocol):
    """ที่รับผลการเล่นไปเก็บ

    hub ไม่รู้จักฐานข้อมูล มันแค่บอกว่าเกิดอะไรขึ้น ส่วนจะเก็บหรือไม่เก็บเป็นเรื่องของ
    ผู้เรียก และการเก็บต้องไม่มีวันทำให้เกมสะดุด
    """

    def match_started(self, match: Match, seats: list[dict[str, Any]]) -> None: ...

    def turns_played(self, match: Match, turns: list[dict[str, Any]]) -> None: ...

    def match_finished(self, match: Match, outcome: dict[str, Any]) -> None: ...


class Hub:
    def __init__(
        self,
        registry: GameRegistry,
        *,
        auth_secret: str,
        scheduler: Scheduler | None = None,
        public_url: str = "http://localhost:8000",
        turn_seconds: int = 45,
        bot_step_delay: float = 0.6,
        autopilot_grace: float = 15.0,
        autopilot_level: str = "normal",
        rng: random.Random | None = None,
        sink: MatchSink | None = None,
        cluster: Cluster | None = None,
    ) -> None:
        self.registry = registry
        self.auth_secret = auth_secret
        self.scheduler = scheduler or AsyncioScheduler()
        self.public_url = public_url.rstrip("/")
        self.turn_seconds = turn_seconds
        self.bot_step_delay = bot_step_delay
        self.autopilot_grace = autopilot_grace
        self.autopilot_level = autopilot_level
        self._rng = rng or random.Random()
        # ที่บันทึกประวัติ — ไม่ใส่ก็เล่นได้ครบ แค่ไม่เก็บอะไรไว้
        self.sink = sink

        self.sessions: dict[str, Session] = {}
        self.rooms: dict[str, Room] = {}
        self.room_by_code: dict[str, str] = {}
        self.matches: dict[str, Match] = {}
        self.queues: dict[str, list[str]] = {}
        self._autopilot_timers: dict[str, Any] = {}

        # ไม่ใส่ cluster = ทำงานเครื่องเดียว ซึ่งเป็นค่าเริ่มต้นและไม่ต้องพึ่งอะไรเลย
        self.cluster = cluster
        #: สำเนาภาพรวมของโหนดอื่น อ่านอย่างเดียว เจ้าของเป็นคนประกาศมาให้
        self.peers: dict[str, Snapshot] = {}
        self._announced: dict[str, Any] | None = None
        if cluster is not None:
            cluster.subscribe(self._on_envelope)
            # โหนดที่เพิ่งขึ้นมายังไม่รู้จักใคร ขอภาพรวมจากเพื่อนบ้านทันที
            # ไม่งั้นคนที่ต่อเข้ามาก่อนรอบประกาศถัดไปจะมองไม่เห็นห้องที่มีอยู่แล้ว
            cluster.broadcast({"kind": "sync"})

    # ── ทางเข้าจาก transport ────────────────────────────────────────────────

    def handle(self, connection: Connection, message: Any) -> None:
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            connection.send({"type": "error", "code": "invalid_message"})
            return

        kind = message["type"]
        if kind == "hello":
            self._on_hello(connection, message)
            return

        session = self.sessions.get(connection.session_id or "")
        if session is None:
            connection.send({"type": "error", "code": "no_session"})
            return
        session.last_seen = time.monotonic()

        if session.home:
            # ชื่ออยู่กับโหนดที่ถือ socket เสมอ แล้วติดไปกับซองทุกใบ
            if kind == "set_name":
                session.name = sanitize_name(message.get("name"), session.name)
            self._forward(session, message)
            return

        handler = getattr(self, f"_on_{kind}", None)
        if handler is None:
            connection.send(
                {"type": "error", "code": "unknown_command", "params": {"action": kind}}
            )
            return
        handler(session, message)

    def disconnect(self, connection: Connection) -> None:
        session = self.sessions.get(connection.session_id or "")
        connection.session_id = None
        if session is None:
            return

        session.connections.discard(connection)
        if session.connections:
            return
        if session.home:
            # สถานะอยู่อีกเครื่อง ที่นั่นต้องเป็นคนตัดสินใจเรื่องนาฬิกาและ AI คุมแทน
            self.cluster.publish(session.home, {"kind": "gone", "session": session.id})
            session.home = None
        self._went_offline(session)

    def _went_offline(self, session: Session) -> None:
        """ผู้เล่นไม่มีการเชื่อมต่อเหลือแล้ว ไม่ว่าจะหลุดจากเครื่องนี้หรือจากเครื่องอื่น"""
        session.last_seen = time.monotonic()
        self._leave_queue(session)
        if session.room_id:
            self._on_leave_room(session, {}, silent=True)
        if session.match_id:
            match = self.matches.get(session.match_id)
            if match is not None:
                self._broadcast_player_status(match, session, connected=False)
                # ให้เวลากลับมาก่อน ถ้าไม่กลับค่อยให้ AI คุมที่นั่งแทน เกมจะได้ไม่ค้าง
                self._schedule_autopilot(match, session)
        self._broadcast_lobby()

    # ── ตัวตน ───────────────────────────────────────────────────────────────

    def _on_hello(self, connection: Connection, message: dict[str, Any]) -> None:
        # client รุ่นเก่าต้องได้คำตอบที่เข้าใจได้ ไม่ใช่เจอข้อความแปลก ๆ แล้วพังเงียบ
        protocol = message.get("protocol")
        if isinstance(protocol, int) and protocol != PROTOCOL_VERSION:
            connection.send(
                {
                    "type": "error",
                    "code": "protocol_mismatch",
                    "params": {"server": PROTOCOL_VERSION, "client": protocol},
                }
            )
            return

        claim: Identity | None = verify_token(message.get("token"), self.auth_secret)
        session = self.sessions.get(claim.id) if claim else None

        if session is None:
            session_id = claim.id if claim else new_guest_id()
            session = Session(
                id=session_id,
                name=sanitize_name(message.get("name"), claim.name if claim else new_guest_name()),
                kind=claim.kind if claim else "guest",
            )
            self.sessions[session.id] = session
        elif claim and claim.kind == "user":
            session.kind = "user"
            session.name = claim.name
        elif message.get("name"):
            session.name = sanitize_name(message["name"], session.name)

        connection.session_id = session.id
        session.connections.add(connection)
        session.last_seen = time.monotonic()

        connection.send(
            {
                "type": "session",
                "id": session.id,
                "name": session.name,
                "kind": session.kind,
                "token": sign_token(session.id, session.name, session.kind, self.auth_secret),
            }
        )
        connection.send(self._lobby_message())

        home = self._home_of(session.id)
        if home:
            # ต่อเข้าเครื่องไหนก็ได้ แล้วเครื่องนั้นพากลับไปหาห้องหรือเกมที่ค้างอยู่เอง
            session.home = home
            self.cluster.publish(home, {"kind": "attach", "session": self._identity(session)})
        else:
            self._resume(session, connection)
        self._broadcast_lobby()

    def _resume(self, session: Session, connection: Connection) -> None:
        """พาผู้เล่นกลับเข้าห้องหรือเกมที่ค้างอยู่"""
        if session.room_id:
            room = self.rooms.get(session.room_id)
            if room is None:
                session.room_id = None
            else:
                connection.send({"type": "room", "room": self._room_view(room)})

        if not session.match_id:
            return
        match = self.matches.get(session.match_id)
        if match is None:
            session.match_id = None
            return
        seat = match.seat_of(session.id)
        if seat == -1:
            session.match_id = None
            return

        connection.send(self._match_start_message(match, seat))
        connection.send({"type": "state", "state": self._state_view(match)})
        if not match.engine.is_active:
            self._send_match_end(match, session.id)
        self._disable_autopilot(match, seat)
        self._broadcast_player_status(match, session, connected=True)

    def _on_set_name(self, session: Session, message: dict[str, Any]) -> None:
        session.name = sanitize_name(message.get("name"), session.name)
        session.send(
            {
                "type": "session",
                "id": session.id,
                "name": session.name,
                "kind": session.kind,
                "token": sign_token(session.id, session.name, session.kind, self.auth_secret),
            }
        )
        if session.room_id:
            self._broadcast_room(session.room_id)

    # ── รายการต่าง ๆ ────────────────────────────────────────────────────────

    def _on_list_games(self, session: Session, message: dict[str, Any]) -> None:
        session.send({"type": "games", "games": self.game_summaries()})

    def game_summaries(self) -> list[dict[str, Any]]:
        playing: dict[str, int] = {}
        for match in self.matches.values():
            if not match.engine.is_active:
                continue
            humans = sum(1 for pid in match.player_ids if not self._is_bot(pid))
            playing[match.game.id] = playing.get(match.game.id, 0) + humans

        open_rooms: dict[str, int] = {}
        for room in self.rooms.values():
            if room.visibility != "public" or room.status == "playing" or room.full:
                continue
            open_rooms[room.game_id] = open_rooms.get(room.game_id, 0) + 1

        for peer in self._live_peers():
            for game_id, count in peer.counts.items():
                if game_id.startswith("playing:"):
                    key = game_id.removeprefix("playing:")
                    playing[key] = playing.get(key, 0) + count
            for summary in peer.rooms:
                open_rooms[summary["gameId"]] = open_rooms.get(summary["gameId"], 0) + 1

        return [
            {
                "id": game.id,
                "icon": game.icon,
                "minPlayers": game.min_players,
                "maxPlayers": game.max_players,
                "defaultTurnSeconds": game.default_turn_seconds,
                "modes": list(game.modes),
                "botLevels": list(game.bot_levels),
                "hasBots": game.has_bots,
                "playing": playing.get(game.id, 0),
                "openRooms": open_rooms.get(game.id, 0),
            }
            for game in self.registry.all()
        ]

    def _on_list_rooms(self, session: Session, message: dict[str, Any]) -> None:
        session.send({"type": "rooms", "rooms": self.public_rooms(message.get("gameId"))})

    def public_rooms(self, game_id: str | None = None) -> list[dict[str, Any]]:
        rooms = []
        for room in self.rooms.values():
            if room.visibility != "public" or room.status == "playing" or room.full:
                continue
            # ไม่ระบุเกม = เอาทุกเกม (หน้ารวมของแพลตฟอร์มใช้แบบนี้)
            if game_id and room.game_id != game_id:
                continue
            host = self.sessions.get(room.host_id)
            bots = sum(1 for member in room.members if self._is_bot(member))
            rooms.append(room.summary(host.name if host else "?", bots))
        for peer in self._live_peers():
            rooms.extend(
                summary for summary in peer.rooms if not game_id or summary["gameId"] == game_id
            )
        return sorted(rooms, key=lambda item: item["createdAt"], reverse=True)

    # ── จับคู่อัตโนมัติ ──────────────────────────────────────────────────────

    def _on_quick_match(self, session: Session, message: dict[str, Any]) -> None:
        if not self._assert_free(session):
            return
        game = self.registry.resolve(message.get("gameId"))
        if session.queued_game == game.id:
            session.send({"type": "queue", "searching": True, "gameId": game.id})
            return

        self._leave_queue(session)
        queue = self.queues.setdefault(game.id, [])
        opponent_id = next(
            (pid for pid in queue if pid != session.id and self._is_online(pid)), None
        )
        if opponent_id is not None:
            queue.remove(opponent_id)
            opponent = self.sessions[opponent_id]
            opponent.queued_game = None
            opponent.send({"type": "queue", "searching": False, "gameId": game.id})
            self.start_match([opponent.id, session.id], game.id, source="quick")
            return

        session.queued_game = game.id
        queue.append(session.id)
        session.send({"type": "queue", "searching": True, "gameId": game.id})
        self._claim_remote_opponent(session, game.id)
        self._broadcast_lobby()

    def _on_cancel_quick_match(self, session: Session, message: dict[str, Any]) -> None:
        game_id = session.queued_game
        self._leave_queue(session)
        session.send({"type": "queue", "searching": False, "gameId": game_id})
        self._broadcast_lobby()

    def _leave_queue(self, session: Session) -> None:
        for queue in self.queues.values():
            if session.id in queue:
                queue.remove(session.id)
        session.queued_game = None

    # ── ห้อง ────────────────────────────────────────────────────────────────

    def _on_create_room(self, session: Session, message: dict[str, Any]) -> None:
        if not self._assert_free(session):
            return
        game = self.registry.resolve(message.get("gameId"))

        capacity = _clamp(
            message.get("capacity", game.min_players), game.min_players, game.max_players
        )
        turn_seconds = _clamp(message.get("turnSeconds", self.turn_seconds), 0, 600)
        mode = message.get("mode") if message.get("mode") in game.modes else game.modes[0]
        bots = _clamp(message.get("bots", 0), 0, capacity - 1)

        # ตั้งค่าเองเมื่อไรก็ไม่นับอันดับ ไม่งั้นตั้งเวลายาว ๆ หรือใส่บอทเพื่อปั่นคะแนนได้
        custom = (
            bots > 0
            or capacity != game.min_players
            or turn_seconds != self.turn_seconds
            or mode != game.modes[0]
        )

        code = room_code()
        while code in self.room_by_code:
            code = room_code()

        room = Room(
            id=str(uuid.uuid4()),
            code=code,
            game_id=game.id,
            host_id=session.id,
            members=[session.id],
            capacity=capacity,
            visibility="public" if message.get("visibility") == "public" else "private",
            mode=mode,
            turn_seconds=turn_seconds,
            custom=custom,
        )
        self.rooms[room.id] = room
        self.room_by_code[code] = room.id
        session.room_id = room.id
        self._leave_queue(session)

        # เติมบอทตามที่ขอมาตั้งแต่สร้างห้อง จะได้ไม่ต้องกดเพิ่มทีละตัว
        level = message.get("botLevel") if message.get("botLevel") in game.bot_levels else None
        for _ in range(bots):
            self._add_bot_to_room(room, level or self.autopilot_level)

        room.refresh_status()
        self._broadcast_room(room.id)
        self._broadcast_room_list()

    def _on_join_room(self, session: Session, message: dict[str, Any]) -> None:
        if not self._assert_free(session):
            return
        raw = str(message.get("code", "")).strip()
        room_id = self.room_by_code.get(raw.upper()) or (raw if raw in self.rooms else None)
        room = self.rooms.get(room_id) if room_id else None

        if room is None:
            owner = self._node_with_room(raw)
            if owner is not None:
                session.home = owner
                self._forward(session, message)
                return
            session.send(
                {"type": "error", "code": "room_not_found", "params": {"code": raw or "-"}}
            )
            return
        if room.status == "playing":
            session.send({"type": "error", "code": "room_playing"})
            return
        if session.id in room.members:
            session.send({"type": "error", "code": "already_in_room"})
            return
        if room.full:
            session.send({"type": "error", "code": "room_full"})
            return

        room.members.append(session.id)
        room.refresh_status()
        session.room_id = room.id
        self._leave_queue(session)
        self._broadcast_room(room.id)
        self._broadcast_room_list()

    def _on_leave_room(
        self, session: Session, message: dict[str, Any], silent: bool = False
    ) -> None:
        room = self.rooms.get(session.room_id or "")
        session.room_id = None
        if room is None:
            return

        if room.host_id == session.id:
            # เจ้าของออก = ปิดห้อง
            for member_id in room.members:
                if member_id == session.id:
                    continue
                member = self.sessions.get(member_id)
                if member is None:
                    continue
                if member.is_bot:
                    self.sessions.pop(member.id, None)
                    continue
                member.room_id = None
                member.send({"type": "room_closed", "code": "room_closed_host_left"})
            self._drop_room(room)
        else:
            room.members = [m for m in room.members if m != session.id]
            room.refresh_status()
            self._send(
                room.host_id,
                {"type": "info", "code": "player_left_room", "params": {"name": session.name}},
            )
            self._broadcast_room(room.id)

        if not silent:
            session.send({"type": "room_closed", "code": "room_closed_you_left"})
        self._broadcast_room_list()
        self._broadcast_lobby()

    def _on_start_room(self, session: Session, message: dict[str, Any]) -> None:
        room = self.rooms.get(session.room_id or "")
        if room is None:
            session.send({"type": "error", "code": "not_in_room"})
            return
        if room.host_id != session.id:
            session.send({"type": "error", "code": "not_room_host"})
            return
        if not room.can_start:
            session.send({"type": "error", "code": "room_needs_players"})
            return

        room.status = "playing"
        player_ids = list(room.members)
        for member_id in player_ids:
            member = self.sessions.get(member_id)
            if member is not None:
                member.room_id = None
        self._drop_room(room)
        self._broadcast_room_list()
        self.start_match(
            player_ids,
            room.game_id,
            source="room",
            mode=room.mode,
            turn_seconds=room.turn_seconds,
            ranked=not room.custom,
        )

    def _on_add_bot(self, session: Session, message: dict[str, Any]) -> None:
        room = self.rooms.get(session.room_id or "")
        if room is None:
            session.send({"type": "error", "code": "not_in_room"})
            return
        if room.host_id != session.id:
            session.send({"type": "error", "code": "not_room_host_bots"})
            return
        if room.status == "playing":
            session.send({"type": "error", "code": "room_playing"})
            return
        if room.full:
            session.send({"type": "error", "code": "room_full_for_bot"})
            return

        game = self.registry.require(room.game_id)
        if not game.has_bots:
            session.send({"type": "error", "code": "bad_ai_level"})
            return
        level = (
            message.get("level")
            if message.get("level") in game.bot_levels
            else self.autopilot_level
        )
        self._add_bot_to_room(room, level if level in game.bot_levels else game.bot_levels[0])
        room.refresh_status()
        self._broadcast_room(room.id)
        self._broadcast_room_list()

    def _on_remove_bot(self, session: Session, message: dict[str, Any]) -> None:
        room = self.rooms.get(session.room_id or "")
        if room is None or room.host_id != session.id or room.status == "playing":
            session.send({"type": "error", "code": "cannot_manage_bots"})
            return
        bot_id = str(message.get("playerId", ""))
        if not self._is_bot(bot_id) or bot_id not in room.members:
            session.send({"type": "error", "code": "bot_not_found"})
            return

        room.members = [m for m in room.members if m != bot_id]
        room.refresh_status()
        self.sessions.pop(bot_id, None)
        self._broadcast_room(room.id)
        self._broadcast_room_list()

    def _on_invite_to_room(self, session: Session, message: dict[str, Any]) -> None:
        """คำเชิญไม่ต้องเก็บสถานะเลย เพราะการตอบรับคือการเข้าห้องด้วยรหัสธรรมดา"""
        room = self.rooms.get(session.room_id or "")
        if room is None:
            session.send({"type": "error", "code": "invite_needs_room"})
            return
        if room.full:
            session.send({"type": "error", "code": "invite_room_full"})
            return

        target = self.sessions.get(str(message.get("targetId", "")))
        if target is None or not target.online:
            session.send({"type": "error", "code": "invite_target_offline"})
            return
        if target.busy:
            session.send(
                {"type": "error", "code": "invite_target_busy", "params": {"name": target.name}}
            )
            return

        target.send(
            {
                "type": "room_invite",
                "id": str(uuid.uuid4()),
                "from": session.public(),
                "gameId": room.game_id,
                "code": room.code,
                "capacity": room.capacity,
                "players": len(room.members),
                "mode": room.mode,
                "turnSeconds": room.turn_seconds,
            }
        )
        session.send({"type": "info", "code": "invite_sent", "params": {"name": target.name}})

    def _on_play_ai(self, session: Session, message: dict[str, Any]) -> None:
        """เล่นกับบอททันทีโดยไม่ต้องสร้างห้อง"""
        if not self._assert_free(session):
            return
        game = self.registry.resolve(message.get("gameId"))
        if not game.has_bots:
            session.send({"type": "error", "code": "bad_ai_level"})
            return

        level = message.get("level")
        if level not in game.bot_levels:
            session.send({"type": "error", "code": "bad_ai_level"})
            return

        self._leave_queue(session)
        bot = self._create_bot_session(level)
        self.start_match(
            [session.id, bot.id],
            game.id,
            source="ai",
            mode=message.get("mode"),
            turn_seconds=message.get("turnSeconds"),
            # เล่นกับบอทไม่นับอันดับ ไม่งั้นเก็บแต้มจากบอทได้ไม่จำกัด
            ranked=False,
        )

    def _add_bot_to_room(self, room: Room, level: str) -> Session:
        bot = self._create_bot_session(level)
        bot.room_id = room.id
        room.members.append(bot.id)
        return bot

    def _create_bot_session(self, level: str) -> Session:
        # ชื่อบอทเป็นกลางทางภาษา client ประกอบชื่อเต็มเองจากระดับ
        bot = Session(id=f"bot_{uuid.uuid4().hex[:6]}", name="AI", kind="guest", bot_level=level)
        self.sessions[bot.id] = bot
        return bot

    def _drop_room(self, room: Room) -> None:
        self.rooms.pop(room.id, None)
        self.room_by_code.pop(room.code, None)

    # ── แมตช์ ───────────────────────────────────────────────────────────────

    def start_match(
        self,
        player_ids: list[str],
        game_id: str,
        *,
        source: str = "quick",
        mode: str | None = None,
        turn_seconds: int | None = None,
        ranked: bool = True,
        shuffle: bool = True,
    ) -> Match:
        game = self.registry.require(game_id)
        seats = list(player_ids)
        if shuffle:
            # สุ่มลำดับที่นั่ง เพราะคนที่เดินก่อนได้เปรียบจริงในเกมกระดาน
            self._rng.shuffle(seats)

        chosen_mode = mode if mode in game.modes else game.modes[0]
        match = Match(
            id=str(uuid.uuid4()),
            game=game,
            engine=game.create(player_count=len(seats), mode=chosen_mode),
            player_ids=seats,
            turn_seconds=self.turn_seconds if turn_seconds is None else turn_seconds,
            # มีบอทร่วมวงเมื่อไรก็ไม่นับอันดับอยู่แล้ว
            ranked=ranked and not any(self._is_bot(pid) for pid in seats),
            mode=chosen_mode,
        )
        self.matches[match.id] = match

        for seat, player_id in enumerate(seats):
            session = self.sessions.get(player_id)
            if session is None:
                continue
            session.match_id = match.id
            session.room_id = None
            self._leave_queue(session)
            session.send(self._match_start_message(match, seat))

        if self.sink is not None:
            self.sink.match_started(
                match,
                [
                    {
                        "seat": seat_index,
                        "playerId": player_id,
                        "name": ((session := self.sessions.get(player_id)) and session.name) or "",
                        "isBot": bool(session and session.is_bot),
                        "botLevel": session.bot_level if session else None,
                    }
                    for seat_index, player_id in enumerate(seats)
                ],
            )

        match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))
        self._broadcast_state(match)
        first = self.sessions.get(seats[0])
        self._broadcast(
            match,
            {
                "type": "info",
                "code": "first_player",
                "params": {"name": first.name if first else ""},
            },
        )
        self._broadcast_lobby()
        return match

    def _on_action(self, session: Session, message: dict[str, Any]) -> None:
        """ทุกการเล่นเข้าทางนี้ทางเดียว แล้วส่งต่อให้ engine ตัดสิน"""
        match = self.matches.get(session.match_id or "")
        if match is None:
            session.send({"type": "error", "code": "not_in_match"})
            return
        seat = match.seat_of(session.id)
        if seat == -1:
            return

        # ลงมือเองเมื่อไร ก็ถือว่ากลับมาคุมเองเมื่อนั้น
        self._disable_autopilot(match, seat)
        if not match.engine.is_active:
            session.send({"type": "error", "code": "game_ended"})
            return

        turn_before = match.engine.turn
        result = match.engine.apply(
            seat, str(message.get("action", "")), message.get("payload") or {}
        )
        if not result.ok and result.error is not None:
            session.send(
                {"type": "error", "code": result.error.code, "params": result.error.params}
            )
            session.send({"type": "state", "state": self._state_view(match)})
            return

        if match.engine.turn != turn_before:
            match.clear_end_offer()
            match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))
        self._broadcast_state(match)
        if not match.engine.is_active:
            self._finish_match(match)

    def _on_offer_end(self, session: Session, message: dict[str, Any]) -> None:
        match = self.matches.get(session.match_id or "")
        if match is None or not match.engine.is_active:
            return
        seat = match.seat_of(session.id)
        if seat == -1:
            return

        match.clear_end_offer()
        match.end_offer_by = seat
        match.end_votes.add(seat)
        self._broadcast(match, {"type": "end_offer", "by": seat})
        if self._try_finish_by_agreement(match):
            return
        self._broadcast_state(match)

    def _on_respond_end(self, session: Session, message: dict[str, Any]) -> None:
        match = self.matches.get(session.match_id or "")
        if match is None or not match.engine.is_active or match.end_offer_by is None:
            return
        seat = match.seat_of(session.id)
        if seat == -1:
            return
        accept = bool(message.get("accept"))

        # ผู้เสนอเองก็ถอนคำขอได้ ไม่ต้องรอให้คนอื่นปฏิเสธ
        if seat == match.end_offer_by:
            if accept:
                return
            match.clear_end_offer()
            self._broadcast(
                match,
                {"type": "info", "code": "end_offer_cancelled", "params": {"name": session.name}},
            )
            self._broadcast_state(match)
            return

        if accept:
            match.end_votes.add(seat)
            if self._try_finish_by_agreement(match):
                return
        else:
            match.clear_end_offer()
            self._broadcast(
                match,
                {"type": "info", "code": "end_offer_declined", "params": {"name": session.name}},
            )
        self._broadcast_state(match)

    def _on_resign(self, session: Session, message: dict[str, Any]) -> None:
        match = self.matches.get(session.match_id or "")
        if match is None or not match.engine.is_active:
            return
        self._retire(match, session, "player_resigned")

    def _on_leave_match(self, session: Session, message: dict[str, Any]) -> None:
        match = self.matches.get(session.match_id or "")
        session.match_id = None
        if match is None:
            self._broadcast_lobby()
            return

        seat = match.seat_of(session.id)
        if match.engine.is_active and seat != -1:
            # ออกจากเกมไม่ใช่การยอมแพ้ คะแนนยังเป็นของเจ้าของที่นั่ง และ AI เล่นต่อให้
            self._broadcast(
                match,
                {"type": "info", "code": "player_left_autopilot", "params": {"name": session.name}},
            )
            self._enable_autopilot(match, seat)
        self._broadcast_player_status(match, session, connected=False)
        if not self._has_human_presence(match):
            self._dispose_match(match)
        self._broadcast_lobby()

    def _on_rematch(self, session: Session, message: dict[str, Any]) -> None:
        match = self.matches.get(session.match_id or "")
        if match is None or match.engine.is_active:
            return
        match.rematch_requests.add(session.id)
        # บอทตอบรับเสมอ ไม่งั้นการขอเล่นใหม่กับ AI จะค้าง
        match.rematch_requests.update(pid for pid in match.player_ids if self._is_bot(pid))
        self._broadcast(
            match, {"type": "rematch_status", "requested": sorted(match.rematch_requests)}
        )

        if not all(pid in match.rematch_requests for pid in match.player_ids):
            return

        # บอทมีอายุเท่ากับแมตช์ ถ้าเอา id เดิมไปเปิดแมตช์ใหม่ ที่นั่งนั้นจะกลายเป็น
        # คนไร้ชื่อที่หลุดการเชื่อมต่อและไม่มีใครเดินให้ จึงต้องสร้างบอทตัวใหม่
        seats = [(pid, self._bot_level(pid)) for pid in match.player_ids]
        rotated = seats[1:] + seats[:1]
        game_id, mode, turn_seconds, ranked = (
            match.game.id,
            match.mode,
            match.turn_seconds,
            match.ranked,
        )
        self._dispose_match(match)
        self.start_match(
            [self._create_bot_session(level).id if level else pid for pid, level in rotated],
            game_id,
            source="quick",
            mode=mode,
            turn_seconds=turn_seconds,
            ranked=ranked,
            # หมุนลำดับที่นั่งเพื่อความยุติธรรม จึงไม่สุ่มซ้ำ
            shuffle=False,
        )

    def _retire(self, match: Match, session: Session, code: str) -> None:
        seat = match.seat_of(session.id)
        if seat == -1 or not match.engine.is_active:
            return

        match.engine.retire(seat)
        match.end_votes.discard(seat)
        self._broadcast(match, {"type": "info", "code": code, "params": {"name": session.name}})

        if not match.engine.is_active:
            self._finish_match(match)
            return
        # คำขอที่ค้างอยู่ยังใช้ได้ เสียงของคนที่เหลือไม่ควรหายเพราะมีคนถอนตัว
        if match.end_offer_by == seat:
            match.clear_end_offer()
        match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))
        self._broadcast_state(match)
        self._try_finish_by_agreement(match)

    def _end_votes_needed(self, match: Match) -> int:
        return sum(
            1 for seat in match.engine.active_players() if not self._bot_for_seat(match, seat)
        )

    def _try_finish_by_agreement(self, match: Match) -> bool:
        """จบได้ก็ต่อเมื่อคนที่ยังเล่นอยู่ทุกคนโหวตให้จบ

        คิดว่าใครต้องโหวตตอนนี้ ไม่ใช่ตอนเสนอ เพราะระหว่างรออาจมีคนถอนตัว
        หรือมี AI เข้าคุมที่นั่งแทน ซึ่งเปลี่ยนจำนวนเสียงที่ต้องการ
        """
        if match.end_offer_by is None:
            return False
        pending = [
            seat
            for seat in match.engine.active_players()
            if seat not in match.end_votes and not self._bot_for_seat(match, seat)
        ]
        if pending:
            return False
        match.engine.end(EndReason.AGREEMENT)
        self._finish_match(match)
        return True

    def _on_turn_timeout(self, match: Match) -> None:
        if not match.engine.is_active:
            return
        seat = match.engine.current
        session = self.sessions.get(match.player_ids[seat])
        name = session.name if session else ""

        if self._bot_for_seat(match, seat):
            # บอทเดินช้าผิดปกติ ปล่อยให้ engine เล่นให้จบเทิร์นไปก่อน
            match.engine.auto_play_turn()
            match.clear_end_offer()
            match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))
            self._broadcast_state(match)
            if not match.engine.is_active:
                self._finish_match(match)
            return

        # ปล่อยหมดเวลา = ไม่อยู่ ให้ AI คุมที่นั่งจนกว่าเจ้าตัวจะลงมือเอง
        self._broadcast(
            match, {"type": "info", "code": "turn_timeout_autopilot", "params": {"name": name}}
        )
        self._enable_autopilot(match, seat)
        match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))

    def _persist_new_turns(self, match: Match) -> None:
        """ส่งเฉพาะเทิร์นที่ยังไม่เคยส่ง กันบันทึกซ้ำ"""
        if self.sink is None:
            return
        history = match.engine.view().get("history")
        if history is None:
            # เกมที่ไม่เปิดเผยประวัติทั้งก้อน ใช้เทิร์นล่าสุดแทน
            last = match.engine.view().get("lastTurn")
            if last and last.get("turn", 0) > match.persisted_turns:
                match.persisted_turns = int(last["turn"])
                self.sink.turns_played(match, [last])
            return
        fresh = history[match.persisted_turns :]
        if fresh:
            match.persisted_turns = len(history)
            self.sink.turns_played(match, fresh)

    def _finish_match(self, match: Match) -> None:
        match.clear_clock()
        match.clear_bot()
        self._broadcast_state(match)
        result = match.engine.result
        if self.sink is not None and result is not None:
            self.sink.match_finished(
                match,
                {
                    "reason": result.reason.value,
                    "scores": list(result.scores),
                    "winners": list(result.winners),
                    "retired": list(match.engine.retired),
                    "turns": match.persisted_turns,
                },
            )
        for player_id in match.player_ids:
            self._send_match_end(match, player_id)
        self._broadcast_lobby()

    def _send_match_end(self, match: Match, session_id: str) -> None:
        result = match.engine.result
        if result is None:
            return
        self._send(
            session_id,
            {
                "type": "match_end",
                "matchId": match.id,
                "ranked": match.ranked,
                "result": {
                    "reason": result.reason.value,
                    "scores": list(result.scores),
                    "winners": list(result.winners),
                },
                "stats": match.engine.stats(),
                "players": self._match_players(match),
            },
        )

    def _dispose_match(self, match: Match) -> None:
        match.clear_clock()
        match.clear_bot()
        self.matches.pop(match.id, None)
        for player_id in match.player_ids:
            self._autopilot_timers.pop(f"{match.id}:{player_id}", None)
            session = self.sessions.get(player_id)
            if session is None:
                continue
            if session.match_id == match.id:
                session.match_id = None
            if session.is_bot:
                self.sessions.pop(session.id, None)

    # ── บอทและ AI คุมแทน ────────────────────────────────────────────────────

    def _bot_level(self, session_id: str) -> str | None:
        session = self.sessions.get(session_id)
        return session.bot_level if session else None

    def _bot_for_seat(self, match: Match, seat: int) -> str | None:
        """ระดับ AI ที่ควรเดินให้ที่นั่งนี้ — บอทจริง หรือ AI ที่คุมแทนคนที่หายไป"""
        return self._bot_level(match.player_ids[seat]) or match.autopilot.get(seat)

    def _maybe_move_bot(self, match: Match) -> None:
        if not match.engine.is_active:
            match.clear_bot()
            return
        level = self._bot_for_seat(match, match.engine.current)
        if level is None or match.game.create_bot is None:
            return
        # ไม่มีคนดูอยู่ก็หยุดพักไว้ก่อน จะได้ไม่เดินเกมทิ้งเปล่า ๆ
        if not any(self._is_connected(pid) for pid in match.player_ids):
            return
        match.schedule_bot(
            self.scheduler, self.bot_step_delay, lambda: self._step_bot(match, level)
        )

    def _step_bot(self, match: Match, level: str) -> None:
        """เดินทีละก้าวเพื่อให้ผู้เล่นเห็นการกินต่อเนื่องค่อย ๆ คลี่"""
        match.bot_timer_fired()
        if not match.engine.is_active:
            return
        if self._bot_for_seat(match, match.engine.current) != level:
            return
        if match.game.create_bot is None:
            return

        if not match.bot_plan:
            match.bot_plan = list(match.game.create_bot(level).plan_turn(match.engine))
            if not match.bot_plan:
                match.engine.end(EndReason.NO_LEGAL_MOVES)
                self._finish_match(match)
                return

        action, payload = match.bot_plan.pop(0)
        turn_before = match.engine.turn
        result = match.engine.apply(match.engine.current, action, payload)
        if not result.ok:
            # แผนใช้ไม่ได้แล้ว ให้ engine เดินให้จบเทิร์นแทน
            match.bot_plan = []
            match.engine.auto_play_turn()

        if match.engine.turn != turn_before:
            match.bot_plan = []
            match.clear_end_offer()
            match.arm_clock(self.scheduler, lambda: self._on_turn_timeout(match))
        self._broadcast_state(match)
        if not match.engine.is_active:
            self._finish_match(match)

    def _schedule_autopilot(self, match: Match, session: Session) -> None:
        seat = match.seat_of(session.id)
        if seat == -1 or not match.engine.is_active or seat in match.autopilot:
            return
        key = f"{match.id}:{session.id}"
        existing = self._autopilot_timers.pop(key, None)
        if existing is not None:
            existing.cancel()

        def take_over() -> None:
            self._autopilot_timers.pop(key, None)
            if self._is_connected(session.id):
                return
            self._enable_autopilot(match, seat)

        if self.autopilot_grace <= 0:
            take_over()
            return
        self._autopilot_timers[key] = self.scheduler.call_later(self.autopilot_grace, take_over)

    def _enable_autopilot(self, match: Match, seat: int) -> None:
        if not match.engine.is_active or seat in match.autopilot:
            return
        if self._is_bot(match.player_ids[seat]):
            return
        if not match.game.has_bots:
            return

        match.autopilot[seat] = self.autopilot_level
        session = self.sessions.get(match.player_ids[seat])
        self._broadcast(
            match,
            {
                "type": "autopilot",
                "seat": seat,
                "name": session.name if session else "",
                "on": True,
            },
        )
        self._broadcast_state(match)

    def _disable_autopilot(self, match: Match, seat: int) -> None:
        timer = self._autopilot_timers.pop(f"{match.id}:{match.player_ids[seat]}", None)
        if timer is not None:
            timer.cancel()
        if match.autopilot.pop(seat, None) is None:
            return
        match.clear_bot()
        session = self.sessions.get(match.player_ids[seat])
        self._broadcast(
            match,
            {
                "type": "autopilot",
                "seat": seat,
                "name": session.name if session else "",
                "on": False,
            },
        )
        self._broadcast_state(match)

    # ── ตัวช่วย ─────────────────────────────────────────────────────────────

    def _assert_free(self, session: Session) -> bool:
        if (session.match_id and session.match_id in self.matches) or (
            session.room_id and session.room_id in self.rooms
        ):
            session.send({"type": "error", "code": "busy"})
            return False
        return True

    def _is_bot(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        return bool(session and session.is_bot)

    def _is_online(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        return bool(session and session.online)

    def _is_connected(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        return bool(session and session.connections)

    def _has_human_presence(self, match: Match) -> bool:
        return any(
            (session := self.sessions.get(pid)) is not None
            and not session.is_bot
            and session.match_id == match.id
            for pid in match.player_ids
        )

    def _send(self, session_id: str, message: dict[str, Any]) -> None:
        session = self.sessions.get(session_id)
        if session is not None:
            session.send(message)

    def _broadcast(self, match: Match, message: dict[str, Any]) -> None:
        for player_id in match.player_ids:
            self._send(player_id, message)

    def _match_players(self, match: Match) -> list[dict[str, Any]]:
        players = []
        for player_id in match.player_ids:
            session = self.sessions.get(player_id)
            players.append(
                session.public() if session else {"id": player_id, "name": "", "connected": False}
            )
        return players

    def _match_start_message(self, match: Match, seat: int) -> dict[str, Any]:
        return {
            "type": "match_start",
            "matchId": match.id,
            "gameId": match.game.id,
            "you": seat,
            "players": self._match_players(match),
            "turnSeconds": match.turn_seconds,
            "ranked": match.ranked,
        }

    def _state_view(self, match: Match) -> dict[str, Any]:
        return match.state_view(self._match_players(match), self._end_votes_needed(match))

    def _broadcast_state(self, match: Match) -> None:
        state = self._state_view(match)
        for player_id in match.player_ids:
            self._send(player_id, {"type": "state", "state": state})
        self._persist_new_turns(match)
        # ทุกครั้งที่สถานะเปลี่ยน ถ้าถึงตาบอทก็ให้มันเดินต่อจากตรงนี้
        self._maybe_move_bot(match)

    def _broadcast_player_status(self, match: Match, session: Session, connected: bool) -> None:
        for other_id in match.others_of(session.id):
            self._send(
                other_id,
                {
                    "type": "player_status",
                    "playerId": session.id,
                    "name": session.name,
                    "connected": connected,
                },
            )

    def _room_view(self, room: Room) -> dict[str, Any]:
        players = []
        for member_id in room.members:
            session = self.sessions.get(member_id)
            players.append(
                session.public() if session else {"id": member_id, "name": "", "connected": False}
            )
        return room.view(players, f"{self.public_url}/join/{room.code}")

    def _broadcast_room(self, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if room is None:
            return
        view = self._room_view(room)
        for member_id in room.members:
            self._send(member_id, {"type": "room", "room": view})

    def _broadcast_room_list(self, announce: bool = True) -> None:
        if announce:
            self._announce()
        for session in self.sessions.values():
            if not session.connections or session.busy:
                continue
            session.send({"type": "rooms", "rooms": self.public_rooms()})

    def _lobby_message(self) -> dict[str, Any]:
        online = in_match = 0
        for session in self.sessions.values():
            if session.is_bot or not session.connections:
                continue
            online += 1
            if session.match_id:
                in_match += 1
        in_queue = sum(len(queue) for queue in self.queues.values())
        for peer in self._live_peers():
            online += peer.counts.get("online", 0)
            in_match += peer.counts.get("inMatch", 0)
            in_queue += peer.counts.get("inQueue", 0)
        return {
            "type": "lobby",
            "online": online,
            "inMatch": in_match,
            "inQueue": in_queue,
            "games": self.game_summaries(),
        }

    def _broadcast_lobby(self, announce: bool = True) -> None:
        # announce=False เมื่อกำลังตอบสนองต่อประกาศของโหนดอื่น ไม่งั้นสองโหนด
        # จะประกาศตอบกันไปมาไม่รู้จบ
        if announce:
            self._announce()
        message = self._lobby_message()
        for session in self.sessions.values():
            if session.connections:
                session.send(message)

    # ── ข้ามเครื่อง ─────────────────────────────────────────────────────────
    #
    # ทุกอย่างในส่วนนี้ไม่ทำงานเลยเมื่อไม่ได้ตั้ง cluster ซึ่งเป็นค่าเริ่มต้น
    # เครื่องเดียวจึงไม่ต้องแบกอะไรเพิ่ม และเทสต์เดิมทั้งหมดยังเดินเส้นทางเดิม

    async def start(self) -> None:
        """เรียกตอนแอปเริ่ม — ต้องมี event loop แล้วถึงจะตั้งงานตามเวลาได้"""
        if self.cluster is None:
            return
        await self.cluster.start()
        self._heartbeat()

    async def stop(self) -> None:
        if self.cluster is not None:
            self.cluster.broadcast({"kind": "bye"})
            await self.cluster.stop()

    def _heartbeat(self) -> None:
        """ประกาศซ้ำเป็นระยะ เผื่อโหนดที่เพิ่งขึ้นมาพลาดรอบก่อน และเก็บกวาดโหนดที่ตายไป"""
        stale = [
            node
            for node, peer in self.peers.items()
            if time.monotonic() - peer.heard_at > PEER_TIMEOUT
        ]
        for node in stale:
            self._forget_peer(node)
        self._announce(force=True)
        self.scheduler.call_later(SNAPSHOT_INTERVAL, self._heartbeat)

    def _identity(self, session: Session) -> dict[str, Any]:
        return {"id": session.id, "name": session.name, "kind": session.kind}

    def _forward(self, session: Session, message: dict[str, Any]) -> None:
        """ส่งคำสั่งไปให้โหนดที่ถือห้องหรือแมตช์ของผู้เล่นคนนี้"""
        self.cluster.publish(
            session.home,
            {"kind": "forward", "session": self._identity(session), "message": message},
        )

    def _live_peers(self) -> list[Snapshot]:
        return list(self.peers.values())

    def _home_of(self, session_id: str) -> str | None:
        """โหนดที่ถือห้องหรือแมตช์ของ session นี้อยู่ ถ้าไม่ใช่เครื่องนี้"""
        for node, peer in self.peers.items():
            if session_id in peer.homes:
                return node
        return None

    def _node_with_room(self, code: str) -> str | None:
        wanted = code.upper()
        for node, peer in self.peers.items():
            if wanted in peer.codes or code in peer.codes.values():
                return node
        return None

    def _snapshot(self) -> dict[str, Any]:
        playing: dict[str, int] = {}
        for match in self.matches.values():
            if match.engine.is_active:
                humans = sum(1 for pid in match.player_ids if not self._is_bot(pid))
                key = f"playing:{match.game.id}"
                playing[key] = playing.get(key, 0) + humans

        online = in_match = 0
        users: list[str] = []
        homes: list[str] = []
        for session in self.sessions.values():
            if session.is_bot:
                continue
            if session.busy:
                homes.append(session.id)
            if not session.connections:
                continue
            online += 1
            if session.match_id:
                in_match += 1
            if session.kind == "user":
                users.append(session.id)

        rooms = []
        codes = {}
        for room in self.rooms.values():
            if room.visibility == "public" and room.status != "playing" and not room.full:
                host = self.sessions.get(room.host_id)
                bots = sum(1 for member in room.members if self._is_bot(member))
                rooms.append(room.summary(host.name if host else "?", bots))
            if room.status != "playing":
                codes[room.code] = room.id

        return Snapshot(
            node=self.cluster.node_id,
            users=users,
            rooms=rooms,
            codes=codes,
            queues={
                game_id: [
                    self._identity(self.sessions[pid]) for pid in queue if pid in self.sessions
                ]
                for game_id, queue in self.queues.items()
                if queue
            },
            homes=homes,
            counts={
                "online": online,
                "inMatch": in_match,
                "inQueue": sum(len(queue) for queue in self.queues.values()),
                **playing,
            },
        ).as_dict()

    def _announce(self, force: bool = False) -> None:
        if self.cluster is None:
            return
        snapshot = self._snapshot()
        # ไม่มีอะไรเปลี่ยนก็ไม่ต้องกวนโหนดอื่น
        if not force and snapshot == self._announced:
            return
        self._announced = snapshot
        self.cluster.broadcast({"kind": "snapshot", "snapshot": snapshot})

    def _forget_peer(self, node: str) -> None:
        gone = self.peers.pop(node, None)
        if gone is None:
            return
        # โหนดที่ถือห้องของใครอยู่ตายไป คนที่ชี้ไปหามันต้องหลุดออกมาเป็นอิสระ
        # ไม่งั้นคำสั่งจะถูกส่งไปยังที่ที่ไม่มีใครรับแล้วค้างอยู่อย่างนั้น
        for session in self.sessions.values():
            if session.home == node:
                session.home = None
                session.send({"type": "error", "code": "server_error"})

    # ── ซองที่มาจากโหนดอื่น ─────────────────────────────────────────────────

    def _on_envelope(self, envelope: dict[str, Any]) -> None:
        kind = envelope.get("kind")
        sender = str(envelope.get("from", ""))
        handler = getattr(self, f"_env_{kind}", None)
        if handler is None or not sender:
            return
        handler(sender, envelope)
        # ตรวจเฉพาะคนที่ซองใบนี้แตะ ไม่ใช่ไล่ทั้งเครื่อง เพราะทางนี้คือทางเดินของทุกตาเดิน
        touched = envelope.get("session")
        if isinstance(touched, dict):
            touched = touched.get("id")
        if isinstance(touched, str):
            self._reap_guest(touched)

    def _env_snapshot(self, sender: str, envelope: dict[str, Any]) -> None:
        snapshot = Snapshot.from_dict(envelope.get("snapshot") or {})
        snapshot.heard_at = time.monotonic()
        previous = self.peers.get(sender)
        self.peers[sender] = snapshot
        if previous is not None and previous.as_dict() == snapshot.as_dict():
            return
        # ห้องหรือยอดคนของอีกเครื่องเปลี่ยน คนที่นั่งดูหน้ารวมอยู่ที่นี่ต้องเห็นด้วย
        self._broadcast_lobby(announce=False)
        self._broadcast_room_list(announce=False)

    def _env_sync(self, sender: str, envelope: dict[str, Any]) -> None:
        self._announce(force=True)

    def _env_bye(self, sender: str, envelope: dict[str, Any]) -> None:
        self._forget_peer(sender)

    def _env_forward(self, sender: str, envelope: dict[str, Any]) -> None:
        """คำสั่งจากผู้เล่นที่ socket อยู่อีกเครื่อง — จัดการเหมือนคนที่ต่ออยู่ที่นี่"""
        session = self._guest(sender, envelope.get("session") or {})
        message = envelope.get("message")
        if session is None or not isinstance(message, dict):
            return
        handler = getattr(self, f"_on_{message.get('type')}", None)
        if handler is None:
            session.send(
                {
                    "type": "error",
                    "code": "unknown_command",
                    "params": {"action": message.get("type")},
                }
            )
            return
        session.last_seen = time.monotonic()
        handler(session, message)

    def _env_attach(self, sender: str, envelope: dict[str, Any]) -> None:
        """ผู้เล่นต่อกลับเข้ามาอีกเครื่อง — ย้ายปลายทางแล้วส่งสถานะที่ค้างอยู่ให้ใหม่"""
        session = self._guest(sender, envelope.get("session") or {})
        if session is None:
            return
        connection = next(iter(session.connections), None)
        if connection is not None:
            self._resume(session, connection)

    def _env_gone(self, sender: str, envelope: dict[str, Any]) -> None:
        session = self.sessions.get(str(envelope.get("session", "")))
        if session is None:
            return
        session.connections.clear()
        self._went_offline(session)

    def _env_deliver(self, sender: str, envelope: dict[str, Any]) -> None:
        """ข้อความจากเจ้าของห้อง ส่งต่อลง socket จริงที่เครื่องนี้ถืออยู่"""
        session = self.sessions.get(str(envelope.get("session", "")))
        message = envelope.get("message")
        if session is not None and isinstance(message, dict):
            session.send(message)

    def _env_close(self, sender: str, envelope: dict[str, Any]) -> None:
        session = self.sessions.get(str(envelope.get("session", "")))
        if session is not None:
            for connection in tuple(session.connections):
                connection.close()

    def _env_free(self, sender: str, envelope: dict[str, Any]) -> None:
        """เจ้าของบอกว่าผู้เล่นไม่ได้อยู่ในห้องหรือแมตช์แล้ว ตัดสินใจเองได้ต่อจากนี้"""
        session = self.sessions.get(str(envelope.get("session", "")))
        if session is not None and session.home == sender:
            session.home = None

    def _env_claim(self, sender: str, envelope: dict[str, Any]) -> None:
        """อีกเครื่องขอจับคู่คนที่รออยู่ในคิวของเรา"""
        session_id = str(envelope.get("session", ""))
        game_id = str(envelope.get("game", ""))
        session = self.sessions.get(session_id)
        queue = self.queues.get(game_id, [])
        # ถูกจับคู่ไปแล้วระหว่างทางก็ปฏิเสธ ผู้ขอคนแรกที่มาถึงได้ไป
        if session is None or session_id not in queue or session.busy or not session.online:
            self.cluster.publish(sender, {"kind": "claim_no", "session": session_id})
            return
        queue.remove(session_id)
        session.queued_game = None
        session.home = sender
        session.send({"type": "queue", "searching": False, "gameId": game_id})
        self.cluster.publish(
            sender,
            {"kind": "claim_ok", "session": self._identity(session), "game": game_id},
        )
        self._broadcast_lobby()

    def _env_claim_ok(self, sender: str, envelope: dict[str, Any]) -> None:
        info = envelope.get("session") or {}
        game_id = str(envelope.get("game", ""))
        waiting = self._next_in_queue(game_id)
        guest = self._guest(sender, info)
        if guest is None:
            return
        if waiting is None:
            # คนของเราถูกจับคู่ไปทางอื่นก่อน ปล่อยคนที่เพิ่งได้มากลับไปเข้าคิวใหม่
            self._release(guest)
            return
        self._leave_queue(waiting)
        waiting.send({"type": "queue", "searching": False, "gameId": game_id})
        self.start_match([guest.id, waiting.id], game_id, source="quick")

    def _env_claim_no(self, sender: str, envelope: dict[str, Any]) -> None:
        return None

    # ── ผู้เล่นข้ามเครื่องที่เครื่องนี้ถือสถานะให้ ────────────────────────────

    def _guest(self, edge: str, info: dict[str, Any]) -> Session | None:
        """หา session ของผู้เล่นที่ socket อยู่เครื่อง edge สร้างใหม่ถ้ายังไม่มี"""
        session_id = str(info.get("id", ""))
        if not session_id:
            return None
        session = self.sessions.get(session_id)
        if session is None:
            session = Session(
                id=session_id,
                name=str(info.get("name", "")),
                kind=str(info.get("kind", "guest")),
            )
            self.sessions[session_id] = session
        else:
            # ชื่ออยู่กับเครื่องที่ถือ socket เสมอ อันที่ติดมากับซองจึงใหม่กว่าเสมอ
            session.name = str(info.get("name", session.name))
        connection = next(iter(session.connections), None)
        if not isinstance(connection, RemoteConnection) or connection.edge != edge:
            for old in tuple(session.connections):
                session.connections.discard(old)
            session.connections.add(RemoteConnection(self.cluster, edge, session_id))
        return session

    def _reap_guest(self, session_id: str) -> None:
        """คืนอิสระให้ผู้เล่นข้ามเครื่องที่ไม่ได้อยู่ในห้องหรือแมตช์แล้ว"""
        session = self.sessions.get(session_id)
        if session is None or session.busy:
            return
        if isinstance(next(iter(session.connections), None), RemoteConnection):
            self._release(session)

    def _release(self, session: Session) -> None:
        connection = next(iter(session.connections), None)
        if isinstance(connection, RemoteConnection):
            self.cluster.publish(connection.edge, {"kind": "free", "session": session.id})
        self.sessions.pop(session.id, None)

    def _claim_remote_opponent(self, session: Session, game_id: str) -> None:
        """ไม่มีใครรออยู่ที่เครื่องนี้ ลองขอคนที่รออยู่เครื่องอื่น"""
        if self.cluster is None:
            return
        for node, peer in self.peers.items():
            for entry in peer.queues.get(game_id, []):
                if entry.get("id") != session.id:
                    self.cluster.publish(
                        node, {"kind": "claim", "session": entry["id"], "game": game_id}
                    )
                    return

    def _next_in_queue(self, game_id: str) -> Session | None:
        for session_id in self.queues.get(game_id, []):
            session = self.sessions.get(session_id)
            if session is not None and session.online and not session.busy:
                return session
        return None

    def online_ids(self, ids: set[str]) -> set[str]:
        """ใครในรายชื่อนี้กำลังต่ออยู่ — ใช้แสดงสถานะเพื่อน นับทั้งคลัสเตอร์"""
        elsewhere = {user for peer in self._live_peers() for user in peer.users}
        return {pid for pid in ids if self._is_connected(pid) or pid in elsewhere}

    @property
    def stats(self) -> dict[str, int]:
        return {
            "sessions": len(self.sessions),
            "rooms": len(self.rooms),
            "matches": len(self.matches),
            "queue": sum(len(queue) for queue in self.queues.values()),
            "peers": len(self._live_peers()),
        }


def _clamp(value: Any, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = low
    return max(low, min(high, number))
