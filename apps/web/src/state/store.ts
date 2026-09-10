/**
 * สถานะของทั้งหน้าเว็บ
 *
 * เขียนเองด้วย useSyncExternalStore แทนที่จะเพิ่มไลบรารี เพราะสถานะที่นี่มาจาก
 * เซิร์ฟเวอร์เกือบทั้งหมด หน้าที่ของ store คือ "รับข้อความมาแล้วเก็บไว้" เท่านั้น
 * ไม่มีตรรกะเกมอยู่ในนี้เลย
 */

import { useSyncExternalStore } from "react";
import { GameSocket } from "../api/socket";
import type {
  GameSummary,
  MatchEnd,
  MatchStart,
  MatchState,
  RoomSummary,
  RoomView,
  ServerMessage,
} from "../api/types";
import { t } from "../i18n/messages";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

export interface RoomInvite {
  id: string;
  fromName: string;
  gameId: string;
  code: string;
  players: number;
  capacity: number;
  mode: string;
  turnSeconds: number;
}

export interface AppState {
  connected: boolean;
  session: { id: string; name: string; kind: string } | null;
  games: GameSummary[];
  rooms: RoomSummary[];
  lobby: { online: number; inMatch: number; inQueue: number };
  /** เกมที่กำลังดูอยู่ — null คือหน้ารวมของแพลตฟอร์ม */
  activeGameId: string | null;
  searching: boolean;
  room: RoomView | null;
  match: MatchStart | null;
  state: MatchState | null;
  result: MatchEnd | null;
  invite: RoomInvite | null;
  rematchRequested: string[];
  toasts: Toast[];
}

const initial: AppState = {
  connected: false,
  session: null,
  games: [],
  rooms: [],
  lobby: { online: 0, inMatch: 0, inQueue: 0 },
  activeGameId: null,
  searching: false,
  room: null,
  match: null,
  state: null,
  result: null,
  invite: null,
  rematchRequested: [],
  toasts: [],
};

let toastId = 0;

export class Store {
  private state: AppState = initial;
  private listeners = new Set<() => void>();
  readonly socket = new GameSocket();

  constructor() {
    this.socket.subscribe((message) => this.apply(message));
  }

  connect(): void {
    this.socket.connect();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  // ── ข้อความจากเซิร์ฟเวอร์ ────────────────────────────────────────────────

  private apply(message: ServerMessage): void {
    switch (message.type) {
      case "session":
        this.set({
          connected: true,
          session: { id: message.id, name: message.name, kind: message.kind },
        });
        break;
      case "lobby":
        this.set({
          lobby: { online: message.online, inMatch: message.inMatch, inQueue: message.inQueue },
          games: message.games,
        });
        break;
      case "games":
        this.set({ games: message.games });
        break;
      case "rooms":
        this.set({ rooms: message.rooms });
        break;
      case "room":
        this.set({ room: message.room, searching: false, activeGameId: message.room.gameId });
        break;
      case "room_closed":
        this.set({ room: null });
        this.toast(t(message.code, message.params));
        break;
      case "room_invite":
        this.set({
          invite: {
            id: message.id,
            fromName: message.from.name,
            gameId: message.gameId,
            code: message.code,
            players: message.players,
            capacity: message.capacity,
            mode: message.mode,
            turnSeconds: message.turnSeconds,
          },
        });
        break;
      case "queue":
        this.set({ searching: message.searching });
        break;
      case "match_start":
        this.set({
          match: {
            matchId: message.matchId,
            gameId: message.gameId,
            you: message.you,
            players: message.players,
            turnSeconds: message.turnSeconds,
            ranked: message.ranked,
          },
          activeGameId: message.gameId,
          room: null,
          result: null,
          searching: false,
          rematchRequested: [],
        });
        break;
      case "state":
        this.set({ state: message.state });
        break;
      case "match_end":
        this.set({ result: message });
        break;
      case "rematch_status":
        this.set({ rematchRequested: message.requested });
        break;
      case "autopilot":
        this.toast(t(message.on ? "autopilot_on" : "autopilot_off", { name: message.name }));
        break;
      case "player_status":
        this.toast(
          t(message.connected ? "player_reconnected" : "player_disconnected", {
            name: message.name,
          }),
        );
        break;
      case "info":
        this.toast(t(message.code, message.params));
        break;
      case "error":
        this.toast(t(message.code, message.params), "error");
        break;
    }
  }

  // ── การกระทำจากหน้าเว็บ ──────────────────────────────────────────────────

  toast(text: string, tone: Toast["tone"] = "info"): void {
    const toast = { id: ++toastId, text, tone };
    this.set({ toasts: [...this.state.toasts, toast] });
    setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((item) => item.id !== toast.id) });
    }, 4000);
  }

  openGame(gameId: string | null): void {
    this.set({ activeGameId: gameId });
    this.socket.send({ type: "list_rooms", gameId: gameId ?? undefined });
  }

  setName(name: string): void {
    GameSocket.rememberName(name);
    this.socket.send({ type: "set_name", name });
  }

  refreshRooms(gameId?: string | null): void {
    this.socket.send({ type: "list_rooms", gameId: gameId ?? undefined });
  }

  quickMatch(gameId: string): void {
    this.socket.send({ type: "quick_match", gameId });
  }

  cancelQuickMatch(): void {
    this.socket.send({ type: "cancel_quick_match" });
  }

  playAi(gameId: string, level: string): void {
    this.socket.send({ type: "play_ai", gameId, level });
  }

  createRoom(options: Record<string, unknown>): void {
    this.socket.send({ type: "create_room", ...options });
  }

  joinRoom(code: string): void {
    this.socket.send({ type: "join_room", code });
    this.set({ invite: null });
  }

  dismissInvite(): void {
    this.set({ invite: null });
  }

  leaveRoom(): void {
    this.socket.send({ type: "leave_room" });
  }

  startRoom(): void {
    this.socket.send({ type: "start_room" });
  }

  addBot(level: string): void {
    this.socket.send({ type: "add_bot", level });
  }

  removeBot(playerId: string): void {
    this.socket.send({ type: "remove_bot", playerId });
  }

  act(action: string, payload: Record<string, unknown> = {}): void {
    this.socket.act(action, payload);
  }

  offerEnd(): void {
    this.socket.send({ type: "offer_end" });
  }

  respondEnd(accept: boolean): void {
    this.socket.send({ type: "respond_end", accept });
  }

  resign(): void {
    this.socket.send({ type: "resign" });
  }

  rematch(): void {
    this.socket.send({ type: "rematch" });
  }

  leaveMatch(): void {
    this.socket.send({ type: "leave_match" });
    this.set({ match: null, state: null, result: null });
  }
}

export const store = new Store();

/**
 * คืนสถานะทั้งก้อน ไม่ใช่ selector
 *
 * เพราะ useSyncExternalStore ต้องการ snapshot ที่อ้างอิงเดิมเมื่อไม่มีอะไรเปลี่ยน
 * selector ที่สร้างวัตถุใหม่ทุกครั้งจะทำให้ re-render ไม่รู้จบ ส่วนตัว state
 * ถูกแทนที่ทั้งก้อนอยู่แล้วจึงเทียบด้วยการอ้างอิงได้ตรง ๆ
 */
export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.snapshot, () => initial);
}
