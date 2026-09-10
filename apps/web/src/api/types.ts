/**
 * รูปร่างข้อมูลที่เซิร์ฟเวอร์ส่งมา
 *
 * ไม่มีข้อความภาษาคนอยู่ในนี้เลย มีแต่รหัสกับตัวเลข คำแปลมาจาก /api/v1/messages
 * แยกต่างหาก ทำให้เปลี่ยนภาษาได้โดยไม่ต้องแตะเซิร์ฟเวอร์ และเช็คข้อผิดพลาดด้วยรหัส
 * แทนการเทียบสตริงที่พังทันทีที่แก้คำพูด
 */

export const PROTOCOL_VERSION = 1;

export type MessageParams = Record<string, string | number | boolean | (string | number)[]>;

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  /** ระดับบอท ถ้าที่นั่งนี้เป็นโปรแกรม */
  bot?: string;
}

export interface GameSummary {
  id: string;
  icon: string;
  minPlayers: number;
  maxPlayers: number;
  defaultTurnSeconds: number;
  modes: string[];
  botLevels: string[];
  hasBots: boolean;
  playing: number;
  openRooms: number;
}

export interface RoomSummary {
  id: string;
  gameId: string;
  hostName: string;
  players: number;
  bots: number;
  capacity: number;
  turnSeconds: number;
  mode: string;
  custom: boolean;
  createdAt: number;
}

export interface RoomView {
  id: string;
  gameId: string;
  code: string;
  hostId: string;
  status: "waiting" | "ready" | "playing";
  visibility: "public" | "private";
  mode: string;
  capacity: number;
  turnSeconds: number;
  custom: boolean;
  players: PublicPlayer[];
  inviteUrl: string;
}

/** สถานะของหมากสี่กระดาน — รูปร่างนี้เป็นของเกมนั้นโดยเฉพาะ */
export interface MakSiKradanView {
  board: number[];
  playerCount: number;
  scores: number[];
  retired: number[];
  current: number;
  turn: number;
  status: "active" | "ended";
  selection: {
    origin: number;
    at: number;
    pieceId: number;
    kind: "capture" | "move";
    path: number[];
    capturedSquares: number[];
    requiredCaptures: number;
    capturesSoFar: number;
    availableCaptures: number | null;
  } | null;
  selectable: number[];
  targets: number[];
  targetKind: "capture" | "move" | "none";
  canEndTurn: boolean;
  rules: { forceCapture: boolean; forceMaximum: boolean; assist: string; touchMove: boolean };
  lastTurn: {
    turn: number;
    player: number;
    pieceId: number;
    kind: string;
    path: number[];
    capturedSquares: number[];
    captures: number;
    missedCaptures: number;
    bestAvailable: number;
  } | null;
  noCaptureStreak: number;
  noCaptureLimit: number;
}

export interface MatchState {
  matchId: string;
  gameId: string;
  mode: string;
  ranked: boolean;
  players: PublicPlayer[];
  turnSeconds: number;
  /** เวลาเซิร์ฟเวอร์ที่เทิร์นนี้หมด (วินาที) */
  deadline: number | null;
  /** เวลาปัจจุบันของเซิร์ฟเวอร์ ใช้ชดเชยนาฬิกาที่ไม่ตรงกัน */
  now: number;
  endOfferBy: number | null;
  endVotes: number[];
  endVotesNeeded: number;
  autopilot: number[];
  view: MakSiKradanView;
}

export interface MatchStart {
  matchId: string;
  gameId: string;
  you: number;
  players: PublicPlayer[];
  turnSeconds: number;
  ranked: boolean;
}

export interface PlayerStats {
  score: number;
  captures: number;
  turns: number;
  bestChain: number;
  bestChainTurn: number | null;
  missedCaptures: number;
  missedTurns: number;
  worstMiss: number;
  worstMissTurn: number | null;
  retired: boolean;
}

export interface MatchEnd {
  matchId: string;
  ranked: boolean;
  result: { reason: string; scores: number[]; winners: number[] };
  stats: { turns: number; piecesLeft: number; players: PlayerStats[] };
  players: PublicPlayer[];
}

export type ServerMessage =
  | { type: "session"; id: string; name: string; kind: string; token: string }
  | { type: "lobby"; online: number; inMatch: number; inQueue: number; games: GameSummary[] }
  | { type: "games"; games: GameSummary[] }
  | { type: "rooms"; rooms: RoomSummary[] }
  | { type: "room"; room: RoomView }
  | { type: "room_closed"; code: string; params?: MessageParams }
  | { type: "room_invite"; id: string; from: PublicPlayer; gameId: string; code: string; capacity: number; players: number; mode: string; turnSeconds: number }
  | { type: "queue"; searching: boolean; gameId: string | null }
  | ({ type: "match_start" } & MatchStart)
  | { type: "state"; state: MatchState }
  | ({ type: "match_end" } & MatchEnd)
  | { type: "player_status"; playerId: string; name: string; connected: boolean }
  | { type: "autopilot"; seat: number; name: string; on: boolean }
  | { type: "end_offer"; by: number }
  | { type: "rematch_status"; requested: string[] }
  | { type: "info"; code: string; params?: MessageParams }
  | { type: "error"; code: string; params?: MessageParams };

export interface ClientConfig {
  apiVersion: number;
  protocolVersion: number;
  environment: string;
  locales: string[];
  defaultLocale: string;
  games: string[];
}
