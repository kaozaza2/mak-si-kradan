/**
 * Hub — Lobby + Matchmaking + Match routing
 *
 * เป็น Authoritative layer ทั้งหมดของฝั่ง server แต่ยังไม่ผูกกับ transport ใด ๆ
 * (ดู §17 และ §34) ตัว WebSocket อยู่ใน index.ts และคุยกับ Hub ผ่าน interface `Connection`
 */

import {
  type AiLevel,
  type AiMove,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type ActionResult,
  type MatchRules,
  RULE_MODE_NAMES,
  RULE_PRESETS,
  type RuleMode,
  chooseMove,
  isAiLevel,
  isRuleMode,
  type PlayerIndex,
} from "../engine/index.js";
import { MatchRoom } from "./match.js";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PublicPlayer,
  type RoomSummary,
  type RoomView,
  type RoomVisibility,
  type ServerMessage,
} from "./protocol.js";
import { randomBytes } from "node:crypto";
import { guestId, guestName, roomCode, sanitizeName, sessionToken, uuid } from "./ids.js";
import { type MatchStore, NullStore } from "./store.js";
import { signToken, verifyToken } from "./auth.js";
import { type Cluster, LocalCluster } from "./cluster.js";

export interface Connection {
  readonly id: string;
  sessionId: string | null;
  send(message: ServerMessage): void;
  close(): void;
}

interface Session {
  id: string;
  token: string;
  name: string;
  kind: "guest" | "user";
  conns: Set<Connection>;
  roomId: string | null;
  matchId: string | null;
  queued: boolean;
  lastSeen: number;
  /** ผู้เล่นที่เป็นบอท ไม่มี connection แต่ถือว่าออนไลน์เสมอ */
  bot: AiLevel | null;
}

interface Room {
  id: string;
  code: string;
  hostId: string;
  /** ผู้เล่นในห้องตามลำดับที่เข้ามา โดยเจ้าของห้องอยู่ลำดับแรกเสมอ */
  members: string[];
  capacity: number;
  visibility: RoomVisibility;
  mode: RuleMode;
  status: "waiting" | "ready" | "playing";
  turnSeconds: number;
  createdAt: number;
}

interface Challenge {
  id: string;
  challengerId: string;
  targetId: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELLED";
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface HubOptions {
  baseUrl?: string;
  defaultTurnSeconds?: number;
  /** เก็บ session ที่ไม่มี connection ไว้นานเท่าไรก่อนทิ้ง (รองรับ reconnect) */
  sessionGraceMs?: number;
  challengeTtlMs?: number;
  /** หน่วงเวลาก่อนบอทเดินแต่ละก้าว เพื่อให้ผู้เล่นเห็น chain ค่อย ๆ คลี่ */
  botStepDelayMs?: number;
  /** รอนานเท่าไรหลังผู้เล่นหลุด ก่อนให้ AI เข้าคุมที่นั่งแทน */
  autopilotGraceMs?: number;
  /** ระดับของ AI ที่เข้ามาคุมแทนผู้เล่นที่หายไป */
  autopilotLevel?: AiLevel;
  /** ที่เก็บข้อมูลถาวร ถ้าไม่ใส่จะไม่บันทึกอะไรเลย */
  store?: MatchStore;
  /** โหมดกติกาเริ่มต้นของ Quick Match และห้องที่ไม่ได้ระบุ */
  defaultMode?: RuleMode;
  /** secret สำหรับตรวจ token ของบัญชีผู้ใช้ */
  authSecret?: string;
  /** ชั้นกระจายหลาย node ถ้าไม่ใส่จะทำงานแบบ node เดียว */
  cluster?: Cluster;
}

const MIN_TURN_SECONDS = 0; // 0 = ไม่จำกัดเวลา
const MAX_TURN_SECONDS = 600;

export class Hub {
  baseUrl: string;
  private readonly defaultTurnSeconds: number;
  private readonly sessionGraceMs: number;
  private readonly challengeTtlMs: number;
  private readonly botStepDelayMs: number;
  private readonly autopilotGraceMs: number;
  private readonly autopilotLevel: AiLevel;
  readonly store: MatchStore;
  private readonly defaultMode: RuleMode;
  private readonly authSecret: string;
  readonly cluster: Cluster;
  /** คนที่ถูกจับคู่จาก node อื่นและกำลังเดินทางมา — รอเขามาถึงแล้วค่อยเปิดแมตช์ */
  private readonly pendingPairings = new Map<string, { hostId: string; expiresAt: number }>();
  private clusterTotals = { online: 0, inMatch: 0, inQueue: 0, nodes: 1 };
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly autopilotTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomIdByCode = new Map<string, string>();
  private readonly matches = new Map<string, MatchRoom>();
  private readonly challenges = new Map<string, Challenge>();
  private queue: string[] = [];
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(options: HubOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://localhost:3000";
    this.defaultTurnSeconds = options.defaultTurnSeconds ?? 45;
    this.sessionGraceMs = options.sessionGraceMs ?? 10 * 60 * 1000;
    this.challengeTtlMs = options.challengeTtlMs ?? 60 * 1000;
    this.botStepDelayMs = options.botStepDelayMs ?? 600;
    this.autopilotGraceMs = options.autopilotGraceMs ?? 15_000;
    this.autopilotLevel = options.autopilotLevel ?? "normal";
    this.store = options.store ?? new NullStore();
    // ค่าเริ่มต้นยึดตามสเปก §9 (บังคับ Maximum Capture) ส่วนโหมดหละหลวม
    // เป็นสิ่งที่ผู้สร้างห้องเลือกเอง
    this.defaultMode = isRuleMode(options.defaultMode) ? options.defaultMode : "assisted";
    // ต้องมี secret เสมอเพราะ token ของ guest ก็ถูกเซ็น ถ้าไม่ตั้งมาก็สุ่มให้
    // (node เดียวใช้ได้ แต่หลาย node ต้องตั้ง AUTH_SECRET ให้ตรงกัน)
    this.authSecret = options.authSecret || randomBytes(32).toString("hex");
    this.cluster = options.cluster ?? new LocalCluster();
    void this.cluster.subscribe(`node:${this.cluster.nodeId}`, (message) => this.onClusterMessage(message));
    this.heartbeatTimer = setInterval(() => void this.syncCluster(), 10_000);
    this.gcTimer = setInterval(() => this.collectGarbage(), 60 * 1000);
  }

  dispose(): void {
    clearInterval(this.gcTimer);
    clearInterval(this.heartbeatTimer);
    void this.cluster.close();
    for (const match of this.matches.values()) {
      match.clearTimer();
      match.clearBot();
    }
    for (const challenge of this.challenges.values()) clearTimeout(challenge.timer);
    for (const timer of this.autopilotTimers.values()) clearTimeout(timer);
    this.autopilotTimers.clear();
  }

  /**
   * ข้อความจาก node อื่น — ตอนนี้มีอย่างเดียวคือ "ส่งคนของคุณมาที่ผมหน่อย"
   * เพราะแมตช์ต้องอยู่ node เดียว ฝ่ายที่จับคู่สำเร็จจึงเป็นเจ้าของแมตช์
   */
  private onClusterMessage(message: any): void {
    if (typeof message?.sessionId !== "string") return;
    const session = this.sessions.get(message.sessionId);
    if (!session || session.conns.size === 0) return;

    if (message.type === "redirect") {
      this.removeFromQueue(session.id);
      session.queued = false;
      this.sendTo(session.id, { type: "queue", searching: false });
      this.sendTo(session.id, { type: "redirect", url: String(message.url ?? ""), code: "redirect_match_found" });
      return;
    }
    if (message.type === "deliver" && message.payload) {
      this.sendTo(session.id, message.payload as ServerMessage);
      return;
    }
    if (message.type === "refresh_friends") void this.onListFriends(session);
  }

  /** ส่งจำนวนคนของ node นี้ขึ้นไปรวม แล้วดึงยอดรวมทุก node กลับมา */
  private async syncCluster(): Promise<void> {
    try {
      await this.cluster.heartbeat(this.localCounts());
      const totals = await this.cluster.totals();
      const changed = JSON.stringify(totals) !== JSON.stringify(this.clusterTotals);
      this.clusterTotals = totals;
      if (changed) this.broadcastLobby();
    } catch (error) {
      console.error("cluster error", error);
    }
  }

  /**
   * เขียนลง store แบบไม่รอผล — ปัญหาที่ฝั่ง DB ต้องไม่ทำให้เกมสะดุด
   *
   * ต่อคิวกันเป็นสายเดียวเพราะลำดับสำคัญ: แถว Match ต้องมีก่อน MatchAction
   * ที่อ้างถึงมัน ถ้าปล่อยให้ยิงขนานกันจะติด foreign key เป็นครั้งคราว
   */
  private persist(operation: () => Promise<unknown>): void {
    this.writeQueue = this.writeQueue
      .then(operation)
      .catch((error) => console.error("store error", error));
  }

  /** รอให้งานเขียนที่ค้างอยู่เสร็จ (ใช้ตอนปิดเซิร์ฟเวอร์และในเทสต์) */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // ---------------------------------------------------------------- transport

  handleMessage(conn: Connection, raw: unknown): void {
    const message = raw as ClientMessage;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      conn.send({ type: "error", code: "invalid_message" });
      return;
    }

    if (message.type === "hello") {
      this.onHello(conn, message);
      return;
    }

    const session = conn.sessionId ? this.sessions.get(conn.sessionId) : undefined;
    if (!session) {
      conn.send({ type: "error", code: "no_session" });
      return;
    }
    session.lastSeen = Date.now();

    switch (message.type) {
      case "set_name": return this.onSetName(session, message.name);
      case "quick_match": return this.onQuickMatch(session);
      case "play_ai": return this.onPlayAi(session, message.level, message.turnSeconds, message.mode);
      case "cancel_quick_match": return this.onCancelQuickMatch(session);
      case "create_room":
        return this.onCreateRoom(session, {
          turnSeconds: message.turnSeconds,
          capacity: message.capacity,
          visibility: message.visibility,
          mode: message.mode,
        });
      case "list_rooms": return this.onListRooms(session);
      case "add_bot": return this.onAddBot(session, message.level);
      case "remove_bot": return this.onRemoveBot(session, message.playerId);
      case "join_room": return this.onJoinRoom(session, message.code);
      case "leave_room": return this.onLeaveRoom(session, "room_closed_you_left");
      case "start_room": return this.onStartRoom(session);
      case "list_players": return this.onListPlayers(session);
      case "list_friends": return void this.onListFriends(session);
      case "friend_request": return void this.onFriendRequest(session, message.identifier);
      case "friend_respond": return void this.onFriendRespond(session, message.requestId, message.accept);
      case "friend_remove": return void this.onFriendRemove(session, message.playerId);
      case "invite_to_room": return void this.onInviteToRoom(session, message.targetId);
      case "challenge": return this.onChallenge(session, message.targetId);
      case "challenge_respond": return this.onChallengeRespond(session, message.challengeId, message.accept);
      case "challenge_cancel": return this.onChallengeCancel(session, message.challengeId);
      case "select": return this.onGameAction(session, (match, seat) => match.game.select(message.square), true);
      case "cancel_select": return this.onGameAction(session, (match) => match.game.clearSelection(), true);
      case "capture": return this.onGameAction(session, (match) => match.game.captureTo(message.to), true);
      case "move": return this.onGameAction(session, (match) => match.game.moveTo(message.to), true);
      case "play": return this.onGameAction(session, (match) => match.game.playTo(message.to), true);
      case "end_turn": return this.onGameAction(session, (match) => match.game.endTurn(), true);
      case "offer_end": return this.onOfferEnd(session);
      case "respond_end": return this.onRespondEnd(session, message.accept);
      case "resign": return this.onResign(session);
      case "rematch": return this.onRematch(session);
      case "leave_match": return this.onLeaveMatch(session);
      default:
        conn.send({ type: "error", code: "unknown_command" });
    }
  }

  handleClose(conn: Connection): void {
    const session = conn.sessionId ? this.sessions.get(conn.sessionId) : undefined;
    conn.sessionId = null;
    if (!session) return;

    session.conns.delete(conn);
    if (session.conns.size > 0) return;

    session.lastSeen = Date.now();
    void this.cluster.markOffline(session.id);
    this.removeFromQueue(session.id);
    session.queued = false;

    if (session.roomId) this.onLeaveRoom(session, "room_closed_disconnected", { silent: true });

    if (session.matchId) {
      const match = this.matches.get(session.matchId);
      if (match) {
        this.broadcastPlayerStatus(match, session, false);
        // ให้เวลากลับมาก่อน ถ้าไม่กลับค่อยให้ AI คุมที่นั่งแทน เกมจะได้ไม่ค้าง
        this.scheduleAutopilot(match, session, this.autopilotGraceMs);
      }
    }
    this.broadcastLobby();
  }

  // ------------------------------------------------------------------ session

  /**
   * เริ่มหรือรื้อฟื้น session
   *
   * token ทั้งของ guest และของบัญชีที่ล็อกอินถูกเซ็นด้วย secret เดียวกัน
   * node ไหนก็ตรวจได้เองโดยไม่ต้องแตะฐานข้อมูลหรือแชร์ตาราง session กัน
   * ซึ่งจำเป็นสำหรับการกระจายหลาย node — คนที่ถูก redirect ไปอีกเครื่อง
   * ต้องยังเป็นคนเดิมพร้อมชื่อเดิมและที่นั่งเดิม
   */
  private onHello(conn: Connection, message: Extract<ClientMessage, { type: "hello" }>): void {
    // client รุ่นเก่า (แอปมือถือที่ยังไม่อัปเดต) ต้องได้รับคำตอบที่เข้าใจได้
    // ไม่ใช่ปล่อยให้เจอข้อความแปลก ๆ แล้วพังเงียบ ๆ
    if (typeof message.protocol === "number" && message.protocol !== PROTOCOL_VERSION) {
      conn.send({
        type: "error",
        code: "protocol_mismatch",
        params: { server: PROTOCOL_VERSION, client: message.protocol },
      });
      return;
    }

    const claim = verifyToken(message.authToken ?? message.token, this.authSecret);
    let session = claim ? this.sessions.get(claim.sub) : undefined;

    if (!session) {
      const id = claim?.sub ?? guestId();
      session = {
        id,
        token: "",
        name: sanitizeName(message.name, claim?.name ?? guestName()),
        kind: claim?.kind === "user" ? "user" : "guest",
        conns: new Set(),
        roomId: null,
        matchId: null,
        queued: false,
        lastSeen: Date.now(),
        bot: null,
      };
      this.sessions.set(id, session);
    } else {
      if (claim?.kind === "user") {
        session.kind = "user";
        session.name = claim.name;
      } else if (message.name) {
        session.name = sanitizeName(message.name, session.name);
      }
    }

    // บัญชีที่สมัครแล้วเปลี่ยนชื่อทางนี้ไม่ได้ ชื่อมาจาก token ที่ออกตอนล็อกอิน
    session.token = this.issueToken(session);
    conn.sessionId = session.id;
    session.conns.add(conn);
    session.lastSeen = Date.now();

    this.persist(() => this.store.saveSession({ id: session.id, name: session.name, kind: session.kind }));
    // ลงทะเบียนว่าอยู่ node ไหนและออนไลน์อยู่ ใช้ทั้งส่งคำเชิญข้ามเครื่องและสถานะเพื่อน
    void this.cluster.claim("session", session.id);
    void this.cluster.markOnline(session.id);
    conn.send({ type: "session", id: session.id, token: session.token, name: session.name, kind: session.kind });
    conn.send(this.lobbyMessage());

    // กลับเข้าห้อง / กลับเข้าเกมที่ค้างอยู่ (§30 Reconnect)
    if (session.roomId) {
      const room = this.rooms.get(session.roomId);
      if (room) conn.send({ type: "room", room: this.roomView(room) });
      else session.roomId = null;
    }

    if (session.matchId) {
      const match = this.matches.get(session.matchId);
      if (match) {
        const seat = match.indexOf(session.id);
        if (seat !== -1) {
          conn.send({
            type: "match_start",
            matchId: match.id,
            you: seat,
            players: this.matchPlayers(match),
            turnSeconds: match.turnSeconds,
            nodeUrl: this.cluster.nodeUrl,
          });
          conn.send({ type: "state", state: match.stateView(this.matchPlayers(match), this.endVotesNeeded(match)) });
          if (!match.game.isActive) this.sendMatchEnd(match, session.id);
          this.disableAutopilot(match, seat);
          for (const otherId of match.othersOf(session.id)) {
            const other = this.sessions.get(otherId);
            if (!other) continue;
            conn.send({
              type: "player_status",
              playerId: otherId,
              name: other.name,
              connected: this.isConnected(otherId),
            });
          }
          this.broadcastPlayerStatus(match, session, true);
        } else {
          session.matchId = null;
        }
      } else {
        session.matchId = null;
      }
    }

    this.consumePendingPairing(session);
    this.broadcastLobby();
  }

  private issueToken(session: Session): string {
    return signToken({ sub: session.id, name: session.name, kind: session.kind }, this.authSecret);
  }

  /** คนที่ถูกจับคู่จาก node อื่นเพิ่งต่อเข้ามา — เปิดแมตช์ให้ทันที */
  private consumePendingPairing(session: Session): void {
    const pending = this.pendingPairings.get(session.id);
    if (!pending) return;
    this.pendingPairings.delete(session.id);
    if (pending.expiresAt < Date.now()) return;

    const host = this.sessions.get(pending.hostId);
    if (!host || !this.isConnected(host.id) || host.matchId || session.matchId) return;

    this.removeFromQueue(host.id);
    host.queued = false;
    void this.cluster.dequeue(session.id);
    this.sendTo(host.id, { type: "queue", searching: false });
    this.startMatch([host.id, session.id], this.defaultTurnSeconds, { source: "quick" });
  }

  private onSetName(session: Session, name: string): void {
    session.name = sanitizeName(name, session.name);
    this.persist(() => this.store.saveSession({ id: session.id, name: session.name, kind: session.kind }));
    this.sendTo(session.id, { type: "session", id: session.id, token: session.token, name: session.name, kind: session.kind });
    if (session.roomId) this.broadcastRoom(session.roomId);
  }

  // --------------------------------------------------------------- matchmaking

  private onQuickMatch(session: Session): void {
    if (!this.assertFree(session, "busy")) return;
    if (session.queued) {
      this.sendTo(session.id, { type: "queue", searching: true });
      return;
    }

    // จับคู่ในเครื่องก่อนเสมอ ไม่ต้องให้ใครเดินทางถ้าอยู่ node เดียวกันอยู่แล้ว
    const opponentId = this.queue.find((id) => id !== session.id && this.isConnected(id));
    if (opponentId) {
      this.removeFromQueue(opponentId);
      const opponent = this.sessions.get(opponentId)!;
      opponent.queued = false;
      this.sendTo(opponentId, { type: "queue", searching: false });
      this.startMatch([opponent.id, session.id], this.defaultTurnSeconds, { source: "quick" });
      return;
    }

    session.queued = true;
    this.queue.push(session.id);
    this.sendTo(session.id, { type: "queue", searching: true });
    this.broadcastLobby();
    if (this.cluster.distributed) void this.tryClusterMatch(session);
  }

  /**
   * หาคู่จากคิวกลางที่ใช้ร่วมกันทุก node
   *
   * ถ้าเจอ node นี้จะเป็นเจ้าของแมตช์ และขอให้อีกฝ่ายย้ายมาต่อที่นี่
   * เพราะแมตช์ต้องมีผู้เขียน state คนเดียว
   */
  private async tryClusterMatch(session: Session): Promise<void> {
    try {
      const waiting = await this.cluster.enqueue({
        sessionId: session.id,
        nodeId: this.cluster.nodeId,
        url: this.cluster.nodeUrl,
      });
      if (!waiting || !session.queued) return;
      if (waiting.nodeId === this.cluster.nodeId) {
        // คนที่รออยู่เป็นคนของ node นี้เอง จับคู่ตรงนี้ได้เลย
        const opponent = this.sessions.get(waiting.sessionId);
        if (opponent && this.isConnected(opponent.id) && !opponent.matchId) {
          this.removeFromQueue(opponent.id);
          opponent.queued = false;
          this.sendTo(opponent.id, { type: "queue", searching: false });
          this.startMatch([opponent.id, session.id], this.defaultTurnSeconds, { source: "quick" });
        }
        return;
      }

      this.pendingPairings.set(waiting.sessionId, {
        hostId: session.id,
        expiresAt: Date.now() + 30_000,
      });
      await this.cluster.publish(`node:${waiting.nodeId}`, {
        type: "redirect",
        sessionId: waiting.sessionId,
        url: this.cluster.nodeUrl,
      });
    } catch (error) {
      console.error("cluster matchmaking error", error);
    }
  }

  private onCancelQuickMatch(session: Session): void {
    this.removeFromQueue(session.id);
    session.queued = false;
    this.sendTo(session.id, { type: "queue", searching: false });
    this.broadcastLobby();
  }

  // ------------------------------------------------------------------ AI match

  private onPlayAi(session: Session, level: AiLevel, turnSeconds?: number, mode?: RuleMode): void {
    if (!isAiLevel(level)) {
      this.sendTo(session.id, { type: "error", code: "bad_ai_level" });
      return;
    }
    if (!this.assertFree(session, "busy")) return;
    this.onCancelQuickMatch(session);

    const bot = this.createBotSession(level);
    this.startMatch([session.id, bot.id], turnSeconds ?? this.defaultTurnSeconds, {
      source: "ai",
      rules: RULE_PRESETS[isRuleMode(mode) ? mode : this.defaultMode],
    });
  }

  private autopilotKey(matchId: string, seat: PlayerIndex): string {
    return `${matchId}:${seat}`;
  }

  private scheduleAutopilot(match: MatchRoom, session: Session, delayMs: number): void {
    const seat = match.indexOf(session.id);
    if (seat === -1 || !match.game.isActive) return;
    if (match.autopilot.has(seat)) return;

    const key = this.autopilotKey(match.id, seat);
    this.cancelAutopilotTimer(key);
    if (delayMs <= 0) {
      this.enableAutopilot(match, seat);
      return;
    }
    this.autopilotTimers.set(
      key,
      setTimeout(() => {
        this.autopilotTimers.delete(key);
        if (this.isConnected(session.id)) return;
        this.enableAutopilot(match, seat);
      }, delayMs),
    );
  }

  private cancelAutopilotTimer(key: string): void {
    const timer = this.autopilotTimers.get(key);
    if (timer) clearTimeout(timer);
    this.autopilotTimers.delete(key);
  }

  /** ให้ AI เข้าคุมที่นั่งนี้แทนเจ้าของ (คะแนนยังเป็นของเจ้าของ) */
  private enableAutopilot(match: MatchRoom, seat: PlayerIndex): void {
    if (!match.game.isActive || match.autopilot.has(seat)) return;
    if (this.sessions.get(match.playerIds[seat])?.bot) return;

    match.autopilot.set(seat, this.autopilotLevel);
    const name = this.sessions.get(match.playerIds[seat])?.name ?? "";
    this.broadcastMatch(match, { type: "autopilot", seat, name, on: true });
    this.broadcastState(match);
  }

  /** เจ้าของที่นั่งกลับมาคุมเอง */
  private disableAutopilot(match: MatchRoom, seat: PlayerIndex): void {
    this.cancelAutopilotTimer(this.autopilotKey(match.id, seat));
    if (!match.autopilot.delete(seat)) return;
    match.clearBot();
    const name = this.sessions.get(match.playerIds[seat])?.name ?? "";
    this.broadcastMatch(match, { type: "autopilot", seat, name, on: false });
    this.broadcastState(match);
  }

  /**
   * ในโหมดที่ไม่บังคับ Maximum Capture บอทก็ควร "ลืมกินต่อ" ได้เหมือนคน
   * ไม่งั้นบอทจะได้เปรียบเชิงระบบทันที เพราะมันไม่มีวันมองข้ามอะไรเลย
   */
  private applyBotFallibility(move: AiMove, level: AiLevel, rules: MatchRules): AiMove {
    if (rules.forceMaximum || move.kind !== "capture" || move.path.length < 2) return move;
    const missRate = { easy: 0.35, normal: 0.15, hard: 0.04 }[level];
    if (Math.random() >= missRate) return move;
    const stopAt = 1 + Math.floor(Math.random() * (move.path.length - 1));
    return { ...move, path: move.path.slice(0, stopAt), captures: stopAt };
  }

  /** ระดับ AI ที่ควรเดินให้ที่นั่งนี้ — บอทจริง หรือ autopilot ของคนที่หายไป */
  private botLevelForSeat(match: MatchRoom, seat: PlayerIndex): AiLevel | null {
    const session = this.sessions.get(match.playerIds[seat]);
    return session?.bot ?? match.autopilot.get(seat) ?? null;
  }

  /** ถ้าถึงตาบอท ให้ตั้งเวลาเดินก้าวถัดไป (เรียกอัตโนมัติทุกครั้งที่ broadcast state) */
  private maybeMoveBot(match: MatchRoom): void {
    if (!match.game.isActive) {
      match.clearBot();
      return;
    }
    const level = this.botLevelForSeat(match, match.game.state.current);
    if (!level) return;
    // ไม่มีคนดูอยู่แล้วก็หยุดพักไว้ก่อน จะได้ไม่เดินเกมทิ้งเปล่า ๆ รอจนมีคนกลับมา
    if (!match.playerIds.some((id) => (this.sessions.get(id)?.conns.size ?? 0) > 0)) return;
    match.scheduleBot(this.botStepDelayMs, () => this.stepBot(match, level));
  }

  /**
   * บอทเดินทีละก้าว ไม่ใช่ทีเดียวจบ เพื่อให้ผู้เล่นเห็น chain ค่อย ๆ คลี่บนกระดาน
   * และเดินผ่าน Game Engine ตัวเดียวกับผู้เล่นจริง กติกาจึงบังคับใช้เหมือนกันทุกประการ
   */
  private stepBot(match: MatchRoom, level: AiLevel): void {
    const game = match.game;
    if (!game.isActive) return;
    if (this.botLevelForSeat(match, game.state.current) !== level) return;

    if (!game.state.selection) {
      const move = chooseMove(game.state, level);
      if (!move) {
        game.endGame("no_legal_moves");
        this.finishMatch(match);
        return;
      }
      match.botPlan = this.applyBotFallibility(move, level, game.state.rules);
      match.botStep = 0;
      if (!game.select(move.from).ok) {
        match.clearBot();
        return;
      }
    } else {
      const to = match.botPlan?.path[match.botStep];
      if (to === undefined) {
        // เดินครบแผนแล้วแต่ยังกินต่อได้ = บอทตั้งใจหยุด (หรือแผนหายหลัง restart)
        if (game.canEndTurn()) game.endTurn();
        else game.playAutoTurn();
      } else if (game.playTo(to).ok) {
        match.botStep += 1;
      } else {
        // แผนใช้ไม่ได้แล้ว ให้ engine เดินให้จบเทิร์นแทน
        game.playAutoTurn();
      }
    }

    if (!game.state.selection) {
      match.clearBot();
      match.clearEndOffer();
      match.armTimer();
    }
    this.broadcastState(match);
    if (!game.isActive) this.finishMatch(match);
  }

  // ---------------------------------------------------------------------- room

  private onCreateRoom(
    session: Session,
    options: {
      turnSeconds?: number;
      capacity?: number;
      visibility?: RoomVisibility;
      mode?: RuleMode;
    },
  ): void {
    if (!this.assertFree(session, "busy")) return;

    let code = roomCode();
    while (this.roomIdByCode.has(code)) code = roomCode();

    const room: Room = {
      id: uuid(),
      code,
      hostId: session.id,
      members: [session.id],
      capacity: clampCapacity(options.capacity),
      visibility: options.visibility === "public" ? "public" : "private",
      mode: isRuleMode(options.mode) ? options.mode : this.defaultMode,
      status: "waiting",
      turnSeconds: clampTurnSeconds(options.turnSeconds ?? this.defaultTurnSeconds),
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.roomIdByCode.set(code, room.id);
    void this.cluster.claim("room", code);
    session.roomId = room.id;
    this.onCancelQuickMatch(session);
    this.broadcastRoom(room.id);
    this.broadcastRoomList();
  }

  /** สร้าง session ของบอทหนึ่งตัว — บอทมีอายุเท่ากับห้องหรือแมตช์ที่มันอยู่ */
  private createBotSession(level: AiLevel): Session {
    const bot: Session = {
      id: `bot_${uuid().slice(0, 6)}`,
      // ไม่มีใครต่อเข้ามาเป็นบอทได้ จึงไม่ลง sessionByToken
      token: sessionToken(),
      // ชื่อบอทเป็นกลางทางภาษา — client ประกอบชื่อเต็มเองจากฟิลด์ bot
      name: "AI",
      kind: "guest",
      conns: new Set(),
      roomId: null,
      matchId: null,
      queued: false,
      lastSeen: Date.now(),
      bot: level,
    };
    this.sessions.set(bot.id, bot);
    return bot;
  }

  private onAddBot(session: Session, level?: AiLevel): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room) {
      this.sendTo(session.id, { type: "error", code: "not_in_room" });
      return;
    }
    if (room.hostId !== session.id) {
      this.sendTo(session.id, { type: "error", code: "not_room_host_bots" });
      return;
    }
    if (room.status === "playing") {
      this.sendTo(session.id, { type: "error", code: "room_playing" });
      return;
    }
    if (room.members.length >= room.capacity) {
      this.sendTo(session.id, { type: "error", code: "room_full_for_bot" });
      return;
    }

    const bot = this.createBotSession(isAiLevel(level) ? level : this.autopilotLevel);
    bot.roomId = room.id;
    room.members.push(bot.id);
    room.status = room.members.length >= 2 ? "ready" : "waiting";
    this.broadcastRoom(room.id);
    this.broadcastRoomList();
  }

  private onRemoveBot(session: Session, playerId: string): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room || room.hostId !== session.id || room.status === "playing") {
      this.sendTo(session.id, { type: "error", code: "cannot_manage_bots" });
      return;
    }
    const bot = this.sessions.get(playerId);
    if (!bot?.bot || !room.members.includes(playerId)) {
      this.sendTo(session.id, { type: "error", code: "bot_not_found" });
      return;
    }

    room.members = room.members.filter((id) => id !== playerId);
    room.status = room.members.length >= 2 ? "ready" : "waiting";
    this.sessions.delete(playerId);
    this.broadcastRoom(room.id);
    this.broadcastRoomList();
  }

  /** รายการห้อง public ที่ยังเข้าได้ — ห้อง private เข้าได้ด้วยรหัสหรือลิงก์เชิญเท่านั้น */
  private onListRooms(session: Session): void {
    this.sendTo(session.id, { type: "rooms", rooms: this.publicRooms() });
  }

  private publicRooms(): RoomSummary[] {
    const rooms: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (room.visibility !== "public") continue;
      if (room.status === "playing") continue;
      if (room.members.length >= room.capacity) continue;
      rooms.push({
        id: room.id,
        hostName: this.sessions.get(room.hostId)?.name ?? "?",
        players: room.members.length,
        bots: room.members.filter((id) => this.sessions.get(id)?.bot).length,
        capacity: room.capacity,
        turnSeconds: room.turnSeconds,
        mode: room.mode,
        createdAt: room.createdAt,
      });
      if (rooms.length >= 50) break;
    }
    return rooms.sort((a, b) => b.createdAt - a.createdAt);
  }

  private onJoinRoom(session: Session, rawCode: string): void {
    if (!this.assertFree(session, "busy")) return;

    const code = String(rawCode ?? "").trim().toUpperCase();
    // รับได้ทั้งรหัสห้องและ room id (หน้ารายการห้อง public ส่ง id มา)
    const roomId = this.roomIdByCode.get(code) ?? (this.rooms.has(String(rawCode)) ? String(rawCode) : undefined);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) {
      // อาจเป็นห้องที่อยู่บน node อื่น — บอกทางให้ client ไปต่อที่นั่น
      if (this.cluster.distributed && code) void this.redirectToRoom(session, code);
      else this.sendTo(session.id, { type: "error", code: "room_not_found", params: { code: code || "-" } });
      return;
    }
    if (room.status === "playing") {
      this.sendTo(session.id, { type: "error", code: "room_playing" });
      return;
    }
    if (room.members.includes(session.id)) {
      this.sendTo(session.id, { type: "error", code: "already_in_room" });
      return;
    }
    if (room.members.length >= room.capacity) {
      this.sendTo(session.id, { type: "error", code: "room_full" });
      return;
    }

    room.members.push(session.id);
    room.status = room.members.length >= 2 ? "ready" : "waiting";
    session.roomId = room.id;
    this.onCancelQuickMatch(session);
    this.broadcastRoom(room.id);
    this.broadcastRoomList();
  }

  private async redirectToRoom(session: Session, code: string): Promise<void> {
    const location = await this.cluster.lookup("room", code).catch(() => null);
    if (!location || location.nodeId === this.cluster.nodeId || !location.url) {
      this.sendTo(session.id, { type: "error", code: "room_not_found", params: { code } });
      return;
    }
    this.sendTo(session.id, { type: "redirect", url: location.url, code: "redirect_room_elsewhere", params: { code } });
  }

  private onLeaveRoom(session: Session, code: string, options: { silent?: boolean } = {}): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    session.roomId = null;
    if (!room) return;

    if (room.hostId === session.id) {
      // เจ้าของออก = ปิดห้อง
      for (const memberId of room.members) {
        if (memberId === session.id) continue;
        const member = this.sessions.get(memberId);
        if (!member) continue;
        if (member.bot) {
          this.sessions.delete(member.id);
          continue;
        }
        member.roomId = null;
        this.sendTo(member.id, { type: "room_closed", code: "room_closed_host_left" });
      }
      this.rooms.delete(room.id);
      this.roomIdByCode.delete(room.code);
      void this.cluster.release("room", room.code);
    } else {
      room.members = room.members.filter((id) => id !== session.id);
      room.status = room.members.length >= 2 ? "ready" : "waiting";
      this.sendTo(room.hostId, { type: "info", code: "player_left_room", params: { name: session.name } });
      this.broadcastRoom(room.id);
    }

    if (!options.silent) this.sendTo(session.id, { type: "room_closed", code });
    this.broadcastRoomList();
    this.broadcastLobby();
  }

  private onStartRoom(session: Session): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room) {
      this.sendTo(session.id, { type: "error", code: "not_in_room" });
      return;
    }
    if (room.hostId !== session.id) {
      this.sendTo(session.id, { type: "error", code: "not_room_host" });
      return;
    }
    if (room.members.length < MIN_PLAYERS) {
      this.sendTo(session.id, { type: "error", code: "room_needs_players" });
      return;
    }

    room.status = "playing";
    const playerIds = [...room.members];
    for (const id of playerIds) {
      const member = this.sessions.get(id);
      if (member) member.roomId = null;
    }
    this.rooms.delete(room.id);
    this.roomIdByCode.delete(room.code);
    void this.cluster.release("room", room.code);
    this.broadcastRoomList();
    // สุ่มลำดับที่นั่งเสมอ ไม่งั้นเจ้าของห้องได้เดินก่อนทุกเกม
    // ซึ่งเป็นความได้เปรียบจริงในเกมนี้ เพราะคนเดินก่อนเลือกหมากจากกระดานเต็มได้ก่อน
    this.startMatch(playerIds, room.turnSeconds, {
      source: "room",
      rules: RULE_PRESETS[room.mode],
    });
  }

  // -------------------------------------------------------------------- friends

  /** ระบบเพื่อนต้องมีตัวตนถาวร guest จึงใช้ไม่ได้ */
  private assertAccount(session: Session): boolean {
    if (session.kind !== "user") {
      this.sendTo(session.id, { type: "error", code: "friends_need_account" });
      return false;
    }
    if (!this.store.supportsAccounts) {
      this.sendTo(session.id, { type: "error", code: "accounts_disabled" });
      return false;
    }
    return true;
  }

  private async onListFriends(session: Session): Promise<void> {
    if (!this.assertAccount(session)) return;
    try {
      const list = await this.store.listFriends(session.id);
      const online = new Set(await this.cluster.onlineAmong(list.friends.map((friend) => friend.id)));
      this.sendTo(session.id, {
        type: "friends",
        friends: list.friends.map((friend) => ({
          ...friend,
          online: online.has(friend.id),
          // ว่างจริงต้องดูจาก node ที่เขาอยู่ ที่นี่บอกได้เฉพาะคนที่อยู่ node เดียวกัน
          available: online.has(friend.id) && !this.isBusy(friend.id),
        })),
        incoming: list.incoming.map((row) => ({ requestId: row.requestId, player: row.player })),
        outgoing: list.outgoing.map((row) => ({ requestId: row.requestId, player: row.player })),
      });
    } catch (error) {
      console.error("friends error", error);
      this.sendTo(session.id, { type: "error", code: "server_error" });
    }
  }

  private isBusy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return Boolean(session.matchId ?? session.roomId);
  }

  private async onFriendRequest(session: Session, identifier: string): Promise<void> {
    if (!this.assertAccount(session)) return;
    const outcome = await this.store.requestFriend(session.id, String(identifier ?? ""));
    if (!outcome.ok) {
      this.sendTo(session.id, { type: "error", code: outcome.code });
      return;
    }

    this.sendTo(session.id, {
      type: "info",
      code: outcome.status === "accepted" ? "friend_added" : "friend_request_sent",
      params: { name: outcome.player.name },
    });
    void this.onListFriends(session);
    // อีกฝ่ายควรเห็นทันทีว่ามีคำขอเข้ามา หรือกลายเป็นเพื่อนกันแล้ว
    await this.nudgeFriendList(outcome.player.id);
  }

  private async onFriendRespond(session: Session, requestId: string, accept: boolean): Promise<void> {
    if (!this.assertAccount(session)) return;
    const outcome = await this.store.respondFriend(session.id, String(requestId ?? ""), Boolean(accept));
    if (!outcome.ok) {
      this.sendTo(session.id, { type: "error", code: outcome.code });
      return;
    }
    this.sendTo(session.id, {
      type: "info",
      code: accept ? "friend_added" : "friend_declined",
      params: { name: outcome.player.name },
    });
    void this.onListFriends(session);
    if (accept) await this.nudgeFriendList(outcome.player.id);
  }

  private async onFriendRemove(session: Session, playerId: string): Promise<void> {
    if (!this.assertAccount(session)) return;
    await this.store.removeFriend(session.id, String(playerId ?? ""));
    this.sendTo(session.id, { type: "info", code: "friend_removed" });
    void this.onListFriends(session);
    await this.nudgeFriendList(String(playerId ?? ""));
  }

  /** บอกอีกฝ่ายให้ดึงรายชื่อเพื่อนใหม่ ไม่ว่าเขาจะอยู่ node ไหน */
  private async nudgeFriendList(playerId: string): Promise<void> {
    const local = this.sessions.get(playerId);
    if (local && local.conns.size > 0) {
      void this.onListFriends(local);
      return;
    }
    if (!this.cluster.distributed) return;
    const location = await this.cluster.lookup("session", playerId).catch(() => null);
    if (location && location.nodeId !== this.cluster.nodeId) {
      await this.cluster.publish(`node:${location.nodeId}`, { type: "refresh_friends", sessionId: playerId });
    }
  }

  // ------------------------------------------------------------- ชวนเข้าห้อง

  /**
   * ชวนผู้เล่นคนหนึ่งเข้าห้องของเรา
   *
   * คำเชิญไม่ต้องเก็บ state ฝั่ง server เลย เพราะการตอบรับคือการ join_room
   * ด้วยรหัสห้องธรรมดา ซึ่งมีเส้นทาง redirect ข้าม node อยู่แล้ว
   */
  private async onInviteToRoom(session: Session, targetId: string): Promise<void> {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room) {
      this.sendTo(session.id, { type: "error", code: "invite_needs_room" });
      return;
    }
    if (room.members.length >= room.capacity) {
      this.sendTo(session.id, { type: "error", code: "invite_room_full" });
      return;
    }

    const target = this.sessions.get(String(targetId ?? ""));
    const invite: ServerMessage = {
      type: "room_invite",
      id: uuid(),
      from: { id: session.id, name: session.name, connected: true },
      code: room.code,
      capacity: room.capacity,
      players: room.members.length,
      mode: room.mode,
      turnSeconds: room.turnSeconds,
    };

    if (target && target.conns.size > 0) {
      if (this.isBusy(target.id)) {
        this.sendTo(session.id, { type: "error", code: "invite_target_busy", params: { name: target.name } });
        return;
      }
      this.sendTo(target.id, invite);
      this.sendTo(session.id, { type: "info", code: "invite_sent", params: { name: target.name } });
      return;
    }

    const delivered = await this.deliverToSession(String(targetId ?? ""), invite);
    this.sendTo(session.id, {
      type: delivered ? "info" : "error",
      code: delivered ? "invite_sent" : "invite_target_offline",
      params: { name: target?.name ?? String(targetId ?? "") },
    });
  }

  /** ส่งข้อความถึง session ที่อาจอยู่ node อื่น */
  private async deliverToSession(sessionId: string, payload: ServerMessage): Promise<boolean> {
    const local = this.sessions.get(sessionId);
    if (local && local.conns.size > 0) {
      this.sendTo(sessionId, payload);
      return true;
    }
    if (!this.cluster.distributed) return false;
    const location = await this.cluster.lookup("session", sessionId).catch(() => null);
    if (!location || location.nodeId === this.cluster.nodeId) return false;
    await this.cluster.publish(`node:${location.nodeId}`, { type: "deliver", sessionId, payload });
    return true;
  }

  // ----------------------------------------------------------------- challenge

  private onListPlayers(session: Session): void {
    const players: PublicPlayer[] = [];
    for (const other of this.sessions.values()) {
      if (other.id === session.id) continue;
      if (other.bot || other.conns.size === 0) continue;
      if (other.matchId || other.roomId) continue;
      players.push({ id: other.id, name: other.name, connected: true });
      if (players.length >= 50) break;
    }
    this.sendTo(session.id, { type: "players", players });
  }

  private onChallenge(session: Session, targetId: string): void {
    if (!this.assertFree(session, "busy")) return;
    const target = this.sessions.get(targetId);
    if (!target || target.conns.size === 0) {
      // อาจอยู่คนละ node — เปลี่ยนเป็นสร้างห้องแล้วส่งคำเชิญไปแทน
      // ซึ่งเดินเส้นทาง redirect ข้ามเครื่องที่มีอยู่แล้ว ไม่ต้องมีสถานะคำท้าข้าม node
      if (this.cluster.distributed) void this.challengeAcrossNodes(session, targetId);
      else this.sendTo(session.id, { type: "error", code: "target_offline" });
      return;
    }
    if (target.id === session.id) {
      this.sendTo(session.id, { type: "error", code: "challenge_self" });
      return;
    }
    if (target.matchId || target.roomId) {
      this.sendTo(session.id, { type: "error", code: "target_busy" });
      return;
    }

    const id = uuid();
    const challenge: Challenge = {
      id,
      challengerId: session.id,
      targetId: target.id,
      status: "PENDING",
      expiresAt: Date.now() + this.challengeTtlMs,
      timer: setTimeout(() => this.expireChallenge(id), this.challengeTtlMs),
    };
    this.challenges.set(id, challenge);

    this.sendTo(session.id, { type: "challenge_update", id, status: "PENDING" });
    this.sendTo(target.id, {
      type: "challenge_in",
      id,
      from: { id: session.id, name: session.name, connected: true },
    });
  }

  private async challengeAcrossNodes(session: Session, targetId: string): Promise<void> {
    const location = await this.cluster.lookup("session", targetId).catch(() => null);
    if (!location || location.nodeId === this.cluster.nodeId) {
      this.sendTo(session.id, { type: "error", code: "target_offline" });
      return;
    }
    this.onCreateRoom(session, { capacity: 2, visibility: "private" });
    this.sendTo(session.id, { type: "info", code: "challenge_became_invite", params: { name: targetId } });
    await this.onInviteToRoom(session, targetId);
  }

  private onChallengeRespond(session: Session, challengeId: string, accept: boolean): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.targetId !== session.id || challenge.status !== "PENDING") {
      this.sendTo(session.id, { type: "error", code: "challenge_gone" });
      return;
    }
    this.closeChallenge(challenge, accept ? "ACCEPTED" : "DECLINED");
    if (!accept) return;

    const challenger = this.sessions.get(challenge.challengerId);
    if (!challenger || challenger.conns.size === 0 || challenger.matchId) {
      this.sendTo(session.id, { type: "error", code: "challenger_unavailable" });
      return;
    }
    this.onCancelQuickMatch(challenger);
    this.onCancelQuickMatch(session);
    this.startMatch([challenger.id, session.id], this.defaultTurnSeconds, { source: "challenge" });
  }

  private onChallengeCancel(session: Session, challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.challengerId !== session.id || challenge.status !== "PENDING") return;
    this.closeChallenge(challenge, "CANCELLED");
  }

  private expireChallenge(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (challenge && challenge.status === "PENDING") this.closeChallenge(challenge, "EXPIRED");
  }

  private closeChallenge(challenge: Challenge, status: Challenge["status"]): void {
    clearTimeout(challenge.timer);
    challenge.status = status;
    this.challenges.delete(challenge.id);
    const update: ServerMessage = { type: "challenge_update", id: challenge.id, status };
    this.sendTo(challenge.challengerId, update);
    this.sendTo(challenge.targetId, update);
  }

  // --------------------------------------------------------------------- match

  private startMatch(
    players: string[],
    turnSeconds: number,
    options: {
      randomizeSeats?: boolean;
      source?: "quick" | "room" | "challenge" | "ai";
      rules?: MatchRules;
    } = {},
  ): MatchRoom {
    // สุ่มลำดับที่นั่ง เพราะคนที่เดินก่อนได้เปรียบเรื่องจังหวะกิน
    // ยกเว้นการเล่นใหม่และการเริ่มจากห้อง ที่กำหนดลำดับไว้แล้ว
    const seats = options.randomizeSeats ?? true ? shuffle(players) : [...players];
    const match = new MatchRoom(
      uuid(),
      seats,
      clampTurnSeconds(turnSeconds),
      (m) => this.onTurnTimeout(m),
      options.rules ?? RULE_PRESETS[this.defaultMode],
    );
    this.matches.set(match.id, match);
    void this.cluster.claim("match", match.id);

    for (const id of seats) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.matchId = match.id;
      session.roomId = null;
      session.queued = false;
      this.removeFromQueue(id);
    }

    const view = this.matchPlayers(match);
    for (const [seat, id] of seats.entries()) {
      this.sendTo(id, {
        type: "match_start",
        matchId: match.id,
        you: seat as PlayerIndex,
        players: view,
        turnSeconds: match.turnSeconds,
        nodeUrl: this.cluster.nodeUrl,
      });
    }
    this.persist(() =>
      this.store.createMatch({
        id: match.id,
        source: options.source ?? "quick",
        playerCount: seats.length,
        turnSeconds: match.turnSeconds,
        players: seats.map((id, seat) => {
          const player = this.sessions.get(id);
          return {
            seat,
            playerId: id,
            name: player?.name ?? "?",
            isBot: Boolean(player?.bot),
            botLevel: player?.bot ?? null,
          };
        }),
      }),
    );

    match.armTimer();
    this.broadcastState(match);
    // บอกให้ชัดว่าใครได้เดินก่อน เพราะลำดับถูกสุ่มทุกครั้ง
    this.broadcastMatch(match, {
      type: "info",
      code: "first_player",
      params: { name: this.sessions.get(seats[0])?.name ?? "" },
    });
    this.broadcastLobby();
    return match;
  }

  private onGameAction(
    session: Session,
    apply: (match: MatchRoom, seat: PlayerIndex) => ActionResult,
    requiresTurn: boolean,
  ): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (!match) {
      this.sendTo(session.id, { type: "error", code: "not_in_match" });
      return;
    }
    const seat = match.indexOf(session.id);
    if (seat === -1) return;
    // ลงมือเองเมื่อไร ก็ถือว่ากลับมาคุมเองเมื่อนั้น
    this.disableAutopilot(match, seat);
    if (!match.game.isActive) {
      this.sendTo(session.id, { type: "error", code: "game_ended" });
      return;
    }
    if (requiresTurn && match.game.state.current !== seat) {
      this.sendTo(session.id, { type: "error", code: "not_your_turn" });
      return;
    }

    const turnBefore = match.game.state.turn;
    const result = apply(match, seat);
    if (!result.ok) {
      this.sendTo(session.id, { type: "error", code: result.code, params: result.params });
      this.sendTo(session.id, {
        type: "state",
        state: match.stateView(this.matchPlayers(match), this.endVotesNeeded(match)),
      });
      return;
    }

    if (match.game.state.turn !== turnBefore) {
      match.clearEndOffer();
      match.armTimer();
    }
    this.broadcastState(match);
    if (!match.game.isActive) this.finishMatch(match);
  }

  private onTurnTimeout(match: MatchRoom): void {
    if (!match.game.isActive) return;
    const seat = match.game.state.current;
    const name = this.sessions.get(match.playerIds[seat])?.name ?? "";

    if (this.botLevelForSeat(match, seat)) {
      // บอทเดินช้าผิดปกติ (เช่นไม่มีคนดูอยู่) ปล่อยให้ engine เล่นให้จบเทิร์นไปก่อน
      match.game.playAutoTurn();
      match.clearEndOffer();
      match.armTimer();
      this.broadcastState(match);
      if (!match.game.isActive) this.finishMatch(match);
      return;
    }

    // ปล่อยหมดเวลา = ไม่อยู่ ให้ AI เข้าคุมที่นั่งจนกว่าเจ้าตัวจะลงมือเอง
    this.broadcastMatch(match, {
      type: "info",
      code: "turn_timeout_autopilot",
      // ส่งระดับดิบ ๆ ไม่ใช่ชื่อภาษาไทย client แปลเอง
      params: { name, level: this.autopilotLevel },
    });
    this.enableAutopilot(match, seat);
    match.armTimer();
  }

  private onOfferEnd(session: Session): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (!match || !match.game.isActive) return;
    const seat = match.indexOf(session.id);
    if (seat === -1) return;

    match.clearEndOffer();
    match.endOfferBy = seat;
    match.endVotes.add(seat);
    this.broadcastMatch(match, { type: "end_offer", by: seat });
    if (this.tryFinishByAgreement(match)) return;
    this.broadcastState(match);
  }

  /**
   * จบเกมได้ก็ต่อเมื่อคนที่ยังเล่นอยู่ทุกคนโหวตให้จบ
   *
   * คิดว่าใครต้องโหวตตอนนี้ ไม่ใช่ตอนเสนอ เพราะระหว่างรอโหวตอาจมีคนถอนตัว
   * หรือมี AI เข้าคุมที่นั่งแทน ซึ่งเปลี่ยนจำนวนเสียงที่ต้องการ
   */
  private pendingEndVotes(match: MatchRoom): PlayerIndex[] {
    return match.game
      .activePlayers()
      .filter((seat) => !match.endVotes.has(seat) && !this.botLevelForSeat(match, seat));
  }

  /** จำนวนเสียงทั้งหมดที่ต้องได้ถึงจะจบเกม */
  private endVotesNeeded(match: MatchRoom): number {
    return match.game.activePlayers().filter((seat) => !this.botLevelForSeat(match, seat)).length;
  }

  private tryFinishByAgreement(match: MatchRoom): boolean {
    if (match.endOfferBy === null) return false;
    if (this.pendingEndVotes(match).length > 0) return false;
    match.game.endGame("agreement");
    this.finishMatch(match);
    return true;
  }

  private onRespondEnd(session: Session, accept: boolean): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (!match || !match.game.isActive || match.endOfferBy === null) return;
    const seat = match.indexOf(session.id);
    if (seat === -1) return;

    // ผู้เสนอเองก็ถอนคำขอได้ ไม่ต้องรอให้คนอื่นปฏิเสธ
    if (seat === match.endOfferBy) {
      if (accept) return;
      match.clearEndOffer();
      this.broadcastMatch(match, { type: "info", code: "end_offer_cancelled", params: { name: session.name } });
      this.broadcastState(match);
      return;
    }

    if (accept) {
      match.endVotes.add(seat);
      if (this.tryFinishByAgreement(match)) return;
      this.broadcastState(match);
    } else {
      match.clearEndOffer();
      this.broadcastMatch(match, { type: "info", code: "end_offer_declined", params: { name: session.name } });
      this.broadcastState(match);
    }
  }

  private onResign(session: Session): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (!match || !match.game.isActive) return;
    this.retirePlayer(match, session, "player_resigned");
  }

  /**
   * ถอนผู้เล่นออกจากเกม — ในเกม 3–4 คน ที่เหลือเล่นกันต่อ
   * เกมจะจบก็ต่อเมื่อเหลือผู้เล่นคนเดียว
   */
  private retirePlayer(match: MatchRoom, session: Session, code: string): void {
    const seat = match.indexOf(session.id);
    if (seat === -1 || !match.game.isActive) return;

    match.game.retire(seat);
    // เสียงของคนที่ถอนตัวไม่นับอีกต่อไป และจำนวนเสียงที่ต้องการก็ลดลงด้วย
    match.endVotes.delete(seat);
    this.broadcastMatch(match, { type: "info", code, params: { name: session.name } });

    if (match.game.isActive) {
      // คำขอที่ค้างอยู่ยังใช้ได้ เสียงของคนที่เหลือไม่ควรหายไปเพราะมีคนถอนตัว
      // ยกเว้นคนถอนตัวเป็นผู้เสนอเอง คำขอนั้นก็หมดความหมาย
      if (match.endOfferBy === seat) match.clearEndOffer();
      match.armTimer();
      this.broadcastState(match);
      // จำนวนเสียงที่ต้องการลดลงแล้ว อาจครบพอดีก็ได้
      this.tryFinishByAgreement(match);
    } else {
      this.finishMatch(match);
    }
  }

  private onRematch(session: Session): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (!match || match.game.isActive) return;
    match.rematchRequests.add(session.id);
    // บอทตอบรับเสมอ ไม่งั้นการขอเล่นใหม่กับ AI จะค้าง
    for (const id of match.playerIds) if (this.sessions.get(id)?.bot) match.rematchRequests.add(id);
    this.broadcastMatch(match, { type: "rematch_status", requested: [...match.rematchRequests] });

    if (match.playerIds.every((id) => match.rematchRequests.has(id))) {
      // บอทมีอายุเท่ากับแมตช์ disposeMatch จะลบ session ทิ้ง
      // ถ้าเอา id เดิมไปเปิดแมตช์ใหม่ ที่นั่งนั้นจะกลายเป็นคนไร้ชื่อที่หลุดการเชื่อมต่อ
      // และไม่มีใครเดินให้ จึงต้องจำระดับไว้แล้วสร้างบอทตัวใหม่
      const seats = match.playerIds.map((id) => ({ id, bot: this.sessions.get(id)?.bot ?? null }));
      const rotated = [...seats.slice(1), seats[0]];
      const rules = match.game.state.rules;
      const turnSeconds = match.turnSeconds;
      this.disposeMatch(match);

      // หมุนลำดับที่นั่งเพื่อความยุติธรรมของสิทธิ์เดินก่อน
      this.startMatch(
        rotated.map((seat) => (seat.bot ? this.createBotSession(seat.bot).id : seat.id)),
        turnSeconds,
        { randomizeSeats: false, source: "quick", rules },
      );
    }
  }

  private onLeaveMatch(session: Session): void {
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    session.matchId = null;
    if (!match) {
      this.broadcastLobby();
      return;
    }
    const seat = match.indexOf(session.id);
    if (match.game.isActive && seat !== -1) {
      // ออกจากเกมไม่ใช่การยอมแพ้ — คะแนนยังเป็นของเจ้าของที่นั่ง และ AI เล่นต่อให้
      this.broadcastMatch(match, {
        type: "info",
        code: "player_left_autopilot",
        params: { name: session.name, level: this.autopilotLevel },
      });
      this.enableAutopilot(match, seat);
    }
    this.broadcastPlayerStatus(match, session, false);
    if (!this.hasHumanPresence(match)) this.disposeMatch(match);
    this.broadcastLobby();
  }

  private finishMatch(match: MatchRoom): void {
    match.clearTimer();
    this.broadcastState(match);

    const state = match.game.state;
    if (state.result) {
      const result = state.result;
      this.persist(() =>
        this.store.finishMatch(match.id, {
          reason: result.reason,
          scores: [...state.scores],
          winners: [...result.winners],
          retired: [...state.retired],
          turns: state.history.length,
          state,
        }),
      );
    }

    for (const id of match.playerIds) this.sendMatchEnd(match, id);
    this.broadcastLobby();
  }

  private sendMatchEnd(match: MatchRoom, sessionId: string): void {
    const result = match.game.state.result;
    if (!result) return;
    this.sendTo(sessionId, {
      type: "match_end",
      matchId: match.id,
      result,
      stats: match.game.stats(),
      history: match.game.state.history,
      players: this.matchPlayers(match),
    });
  }

  private disposeMatch(match: MatchRoom): void {
    match.clearTimer();
    match.clearBot();
    void this.cluster.release("match", match.id);
    for (let seat = 0; seat < match.playerIds.length; seat++) {
      this.cancelAutopilotTimer(this.autopilotKey(match.id, seat));
    }
    match.autopilot.clear();
    this.matches.delete(match.id);
    for (const id of match.playerIds) {
      const session = this.sessions.get(id);
      if (!session) continue;
      if (session.matchId === match.id) session.matchId = null;
      // บอทมีอายุเท่ากับ match ของมัน
      if (session.bot) this.sessions.delete(session.id);
    }
  }

  // ------------------------------------------------------------------- helpers

  private assertFree(session: Session, code: string): boolean {
    if (
      (session.matchId && this.matches.has(session.matchId)) ||
      (session.roomId && this.rooms.has(session.roomId))
    ) {
      this.sendTo(session.id, { type: "error", code });
      return false;
    }
    return true;
  }

  private isConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.bot !== null || session.conns.size > 0;
  }

  /** ยังมีคนจริงนั่งอยู่ใน match นี้ไหม (บอทไม่นับ ไม่งั้น match จะไม่มีวันถูกเก็บกวาด) */
  private hasHumanPresence(match: MatchRoom): boolean {
    return match.playerIds.some((id) => {
      const session = this.sessions.get(id);
      return Boolean(session && !session.bot && session.matchId === match.id);
    });
  }

  private removeFromQueue(sessionId: string): void {
    this.queue = this.queue.filter((id) => id !== sessionId);
    if (this.cluster.distributed) void this.cluster.dequeue(sessionId);
  }

  private matchPlayers(match: MatchRoom): PublicPlayer[] {
    return match.playerIds.map((id) => {
      const session = this.sessions.get(id);
      return {
        id,
        // ไม่มี session แล้ว = ไม่รู้ชื่อ ส่งค่าว่างให้ client เติมข้อความเอง
        name: session?.name ?? "",
        connected: this.isConnected(id),
        ...(session?.bot ? { bot: session.bot } : {}),
      };
    });
  }

  private roomView(room: Room): RoomView {
    return {
      id: room.id,
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      visibility: room.visibility,
      mode: room.mode,
      capacity: room.capacity,
      turnSeconds: room.turnSeconds,
      players: room.members.map((id) => {
        const member = this.sessions.get(id);
        return {
          id,
          name: member?.name ?? "?",
          connected: this.isConnected(id),
          ...(member?.bot ? { bot: member.bot } : {}),
        };
      }),
      inviteUrl: `${this.baseUrl}/join/${room.code}`,
    };
  }

  /** ส่งรายการห้อง public ให้ทุกคนที่อยู่ใน lobby (ไม่ได้อยู่ในห้องหรือในเกม) */
  private broadcastRoomList(): void {
    const rooms = this.publicRooms();
    for (const session of this.sessions.values()) {
      if (session.conns.size === 0 || session.roomId || session.matchId) continue;
      this.sendTo(session.id, { type: "rooms", rooms });
    }
  }

  sendTo(sessionId: string, message: ServerMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const conn of session.conns) conn.send(message);
  }

  private broadcastRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const view = this.roomView(room);
    for (const player of view.players) this.sendTo(player.id, { type: "room", room: view });
  }

  private broadcastPlayerStatus(match: MatchRoom, session: Session, connected: boolean): void {
    for (const id of match.othersOf(session.id)) {
      this.sendTo(id, { type: "player_status", playerId: session.id, name: session.name, connected });
    }
  }

  private broadcastMatch(match: MatchRoom, message: ServerMessage): void {
    for (const id of match.playerIds) this.sendTo(id, message);
  }

  private broadcastState(match: MatchRoom): void {
    const state = match.stateView(this.matchPlayers(match), this.endVotesNeeded(match));
    for (const id of match.playerIds) this.sendTo(id, { type: "state", state });

    const history = match.game.state.history;
    if (history.length > match.persistedTurns) {
      const fresh = history.slice(match.persistedTurns);
      match.persistedTurns = history.length;
      this.persist(() => this.store.recordActions(match.id, fresh));
    }

    // ทุกครั้งที่ state เปลี่ยน ถ้าถึงตาบอทก็ให้มันเดินต่อจากตรงนี้
    this.maybeMoveBot(match);
  }

  private localCounts(): { online: number; inMatch: number; inQueue: number } {
    let online = 0;
    let inMatch = 0;
    for (const session of this.sessions.values()) {
      if (session.bot || session.conns.size === 0) continue;
      online++;
      if (session.matchId) inMatch++;
    }
    return { online, inMatch, inQueue: this.queue.length };
  }

  private lobbyMessage(): ServerMessage {
    const local = this.localCounts();
    // node เดียวก็ใช้ยอดของตัวเอง หลาย node ใช้ยอดรวมที่ heartbeat เก็บมา
    const totals = this.cluster.distributed
      ? {
          online: Math.max(local.online, this.clusterTotals.online),
          inMatch: Math.max(local.inMatch, this.clusterTotals.inMatch),
          inQueue: Math.max(local.inQueue, this.clusterTotals.inQueue),
          nodes: Math.max(1, this.clusterTotals.nodes),
        }
      : { ...local, nodes: 1 };
    return { type: "lobby", ...totals };
  }

  private broadcastLobby(): void {
    const message = this.lobbyMessage();
    for (const session of this.sessions.values()) {
      if (session.conns.size === 0) continue;
      for (const conn of session.conns) conn.send(message);
    }
  }

  private collectGarbage(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.conns.size > 0) continue;
      if (session.bot) {
        // บอทมีอายุเท่ากับห้องหรือแมตช์ที่มันสังกัด ที่เหลือคือบอทกำพร้า
        const inMatch = Boolean(session.matchId && this.matches.has(session.matchId));
        const inRoom = Boolean(session.roomId && this.rooms.has(session.roomId));
        if (!inMatch && !inRoom) this.sessions.delete(session.id);
        continue;
      }
      if (now - session.lastSeen < this.sessionGraceMs) continue;

      if (session.matchId) {
        const match = this.matches.get(session.matchId);
        if (match) {
          if (match.game.isActive) this.retirePlayer(match, session, "player_gone");
          if (!match.playerIds.some((id) => this.sessions.get(id)?.conns.size)) this.disposeMatch(match);
        }
      }
      this.sessions.delete(session.id);
    }

    for (const room of this.rooms.values()) {
      const alive = room.members.some((id) => this.isConnected(id));
      if (!alive && now - room.createdAt > this.sessionGraceMs) {
        this.rooms.delete(room.id);
        this.roomIdByCode.delete(room.code);
      }
    }
  }

  /** สำหรับ test / debug */
  get stats() {
    return {
      sessions: this.sessions.size,
      rooms: this.rooms.size,
      matches: this.matches.size,
      queue: this.queue.length,
      challenges: this.challenges.size,
    };
  }
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clampCapacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return MIN_PLAYERS;
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(value as number)));
}

function clampTurnSeconds(value: number): number {
  if (!Number.isFinite(value)) return 45;
  return Math.min(MAX_TURN_SECONDS, Math.max(MIN_TURN_SECONDS, Math.round(value)));
}
