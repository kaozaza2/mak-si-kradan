/**
 * โปรโตคอลระหว่าง client กับ server (JSON บน WebSocket)
 *
 * Client ไม่ตัดสินกติกาเอง ส่งได้แค่ "เจตนา" เช่น เลือกหมากตัวนี้ / ลงช่องนี้
 * แล้ว server เป็นผู้ตรวจและ broadcast canonical state กลับมา (ดู §28)
 */

import type {
  AiLevel,
  EndReason,
  GameResult,
  MatchRules,
  MatchStats,
  PlayerIndex,
  RuleMode,
  TurnRecord,
} from "../engine/index.js";

/**
 * เวอร์ชันของโปรโตคอล WebSocket
 * เพิ่มเลขนี้เมื่อมีการเปลี่ยนที่ client เก่ารับไม่ได้ — สำคัญกับ crossplay
 * เพราะแอปมือถือที่ผู้ใช้ยังไม่อัปเดตจะยังต่อเข้ามาอยู่
 */
export const PROTOCOL_VERSION = 1;

/**
 * ค่าที่เติมลงในข้อความ
 *
 * โปรโตคอลไม่ส่งข้อความที่คนอ่านได้เลย ส่งแค่ `code` กับ `params`
 * เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร และ client ควรเช็ค error ด้วย code
 * ไม่ใช่เทียบสตริงที่พังทันทีที่เราแก้คำพูด — ดึงแคตตาล็อกได้ที่ GET /api/v1/messages
 */
export type MessageParams = Record<string, string | number | boolean | (string | number)[]>;

export type ClientMessage =
  | { type: "hello"; token?: string; name?: string; authToken?: string; protocol?: number }
  | { type: "set_name"; name: string }
  | { type: "quick_match" }
  | { type: "play_ai"; level: AiLevel; turnSeconds?: number; mode?: RuleMode }
  | { type: "cancel_quick_match" }
  | {
      type: "create_room";
      turnSeconds?: number;
      capacity?: number;
      visibility?: RoomVisibility;
      mode?: RuleMode;
    }
  | { type: "list_rooms" }
  | { type: "add_bot"; level?: AiLevel }
  | { type: "remove_bot"; playerId: string }
  | { type: "join_room"; code: string }
  | { type: "leave_room" }
  | { type: "start_room" }
  | { type: "list_players" }
  | { type: "list_friends" }
  | { type: "friend_request"; identifier: string }
  | { type: "friend_respond"; requestId: string; accept: boolean }
  | { type: "friend_remove"; playerId: string }
  | { type: "invite_to_room"; targetId: string }
  | { type: "challenge"; targetId: string }
  | { type: "challenge_respond"; challengeId: string; accept: boolean }
  | { type: "challenge_cancel"; challengeId: string }
  | { type: "select"; square: number }
  | { type: "cancel_select" }
  | { type: "capture"; to: number }
  | { type: "move"; to: number }
  /** วางหมากลงช่องนี้ แล้วให้ server ตีความเองว่ากินหรือเดิน */
  | { type: "play"; to: number }
  /** จบเทิร์นทั้งที่ยังกินต่อได้ */
  | { type: "end_turn" }
  | { type: "offer_end" }
  | { type: "respond_end"; accept: boolean }
  | { type: "resign" }
  | { type: "rematch" }
  | { type: "leave_match" };

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  /** ระดับของบอท ถ้าผู้เล่นคนนี้เป็น AI */
  bot?: AiLevel;
}

export type RoomVisibility = "public" | "private";

export interface FriendView {
  id: string;
  name: string;
  username: string;
  rating: number;
  online: boolean;
  /** ว่างอยู่ไหม — ถ้าติดเกมหรือติดห้องอยู่ก็ชวนไม่ได้ */
  available: boolean;
}

export interface FriendRequestView {
  requestId: string;
  player: { id: string; name: string; username: string; rating: number };
}

export interface RoomView {
  id: string;
  code: string;
  hostId: string;
  status: "waiting" | "ready" | "playing";
  visibility: RoomVisibility;
  mode: RuleMode;
  /** จำนวนผู้เล่นที่ห้องนี้ตั้งไว้ (2–4) */
  capacity: number;
  turnSeconds: number;
  players: PublicPlayer[];
  inviteUrl: string;
}

/** ข้อมูลย่อของห้อง public สำหรับหน้ารายการห้อง — ไม่เปิดเผยรหัสห้อง */
export interface RoomSummary {
  id: string;
  hostName: string;
  players: number;
  /** ในจำนวน players มีบอทกี่ตัว */
  bots: number;
  capacity: number;
  turnSeconds: number;
  mode: RuleMode;
  createdAt: number;
}

export interface SelectionView {
  origin: number;
  at: number;
  pieceId: number;
  kind: "capture" | "move";
  path: number[];
  capturedSquares: number[];
  requiredCaptures: number;
  capturesSoFar: number;
  /** null เมื่อโหมดไม่ช่วยชี้เป้า */
  availableCaptures: number | null;
}

export interface StateView {
  matchId: string;
  /** piece id ต่อช่อง, -1 = ช่องว่าง */
  board: number[];
  playerCount: number;
  scores: number[];
  /** ที่นั่งของผู้เล่นที่ถอนตัวไปแล้ว */
  retired: PlayerIndex[];
  current: PlayerIndex;
  turn: number;
  status: "active" | "ended";
  selection: SelectionView | null;
  rules: MatchRules;
  /** ยังกินต่อได้ แต่กติกาให้จบเทิร์นเองได้ */
  canEndTurn: boolean;
  /** ช่องที่ผู้เล่นปัจจุบันหยิบได้ (ว่างเปล่าเมื่อโหมดไม่ช่วยชี้เป้า) */
  selectable: number[];
  /** ปลายทางที่ถูกกติกาของหมากที่เลือกอยู่ */
  targets: number[];
  targetKind: "capture" | "move" | "none";
  lastTurn: TurnRecord | null;
  noCaptureStreak: number;
  noCaptureLimit: number;
  turnSeconds: number;
  /** เวลาเซิร์ฟเวอร์ที่เทิร์นนี้จะหมด (epoch ms) — null ถ้าไม่จำกัดเวลา */
  deadline: number | null;
  /** เวลาปัจจุบันของเซิร์ฟเวอร์ ใช้ชดเชย clock skew ฝั่ง client */
  now: number;
  players: PublicPlayer[];
  endOfferBy: PlayerIndex | null;
  endVotes: PlayerIndex[];
  /** ต้องได้กี่เสียงถึงจะจบเกม (ไม่นับที่นั่งที่ AI คุมอยู่) */
  endVotesNeeded: number;
  /** ที่นั่งที่กำลังถูก AI คุมแทนเจ้าของ */
  autopilot: PlayerIndex[];
  stateHash: string;
}

export type ServerMessage =
  | { type: "session"; id: string; token: string; name: string; kind: "guest" | "user" }
  | { type: "lobby"; online: number; inQueue: number; inMatch: number; nodes: number }
  /** ห้อง/แมตช์ที่ต้องการอยู่บน node อื่น ให้ client ต่อไปที่นั่นแทน */
  | { type: "redirect"; url: string; code: string; params?: MessageParams }
  | { type: "players"; players: PublicPlayer[] }
  | { type: "friends"; friends: FriendView[]; incoming: FriendRequestView[]; outgoing: FriendRequestView[] }
  | {
      type: "room_invite";
      id: string;
      from: PublicPlayer;
      code: string;
      capacity: number;
      players: number;
      mode: RuleMode;
      turnSeconds: number;
    }
  | { type: "room"; room: RoomView }
  | { type: "rooms"; rooms: RoomSummary[] }
  | { type: "room_closed"; code: string; params?: MessageParams }
  | { type: "queue"; searching: boolean }
  | { type: "challenge_in"; id: string; from: PublicPlayer }
  | { type: "challenge_update"; id: string; status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELLED" }
  | {
      type: "match_start";
      matchId: string;
      you: PlayerIndex;
      players: PublicPlayer[];
      turnSeconds: number;
      /** URL ของ node ที่ถือแมตช์นี้ — client ใช้ต่อกลับให้ถูกที่ตอน reconnect */
      nodeUrl: string;
    }
  | { type: "state"; state: StateView }
  | { type: "match_end"; matchId: string; result: GameResult; stats: MatchStats; history: TurnRecord[]; players: PublicPlayer[] }
  | { type: "player_status"; playerId: string; name: string; connected: boolean }
  | { type: "autopilot"; seat: PlayerIndex; name: string; on: boolean }
  | { type: "end_offer"; by: PlayerIndex }
  | { type: "rematch_status"; requested: string[] }
  | { type: "info"; code: string; params?: MessageParams }
  | { type: "error"; code: string; params?: MessageParams };

export type { AiLevel, EndReason, GameResult, MatchRules, MatchStats, PlayerIndex, RuleMode, TurnRecord };
