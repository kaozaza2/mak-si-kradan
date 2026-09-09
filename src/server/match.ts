/**
 * Match — game session จริง 1 ห้อง
 *
 * ห่อ Game Engine ไว้พร้อมกับสิ่งที่ engine ไม่ควรรู้จัก:
 * ผู้เล่นคือใคร, นาฬิกาเทิร์น, การโหวตจบเกม และการขอเล่นใหม่
 */

import {
  type AiLevel,
  type AiMove,
  Game,
  type PlayerIndex,
  analyzeCaptures,
  type MatchRules,
  RULE_PRESETS,
  createGameState,
  moveDestinations,
} from "../engine/index.js";
import type { PublicPlayer, StateView } from "./protocol.js";

export class MatchRoom {
  readonly id: string;
  /** ที่นั่งตามลำดับเทิร์น 2–4 คน */
  readonly playerIds: string[];
  readonly turnSeconds: number;
  readonly game: Game;
  readonly rematchRequests = new Set<string>();

  endOfferBy: PlayerIndex | null = null;
  /** ที่นั่งที่โหวตให้จบเกมแล้ว — ต้องครบทุกคนที่ยังอยู่ในเกมถึงจะจบ */
  readonly endVotes = new Set<PlayerIndex>();
  deadline: number | null = null;
  /** ท่าที่บอทตัดสินใจไว้แล้วและกำลังเดินทีละก้าวให้ผู้เล่นเห็น chain ค่อย ๆ คลี่ */
  botPlan: AiMove | null = null;
  botStep = 0;
  /**
   * ที่นั่งที่ให้ AI คุมแทนชั่วคราว เพราะเจ้าของหลุด ออกไป หรือปล่อยหมดเวลา
   * ต่างจากการยอมแพ้ตรงที่เจ้าของยังเป็นเจ้าของคะแนน และกลับมาคุมเองได้ทุกเมื่อ
   */
  readonly autopilot = new Map<PlayerIndex, AiLevel>();
  /** จำนวนเทิร์นที่บันทึกลง store ไปแล้ว ใช้กันเขียนซ้ำ */
  persistedTurns = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: string,
    playerIds: string[],
    turnSeconds: number,
    private readonly onTimeout: (match: MatchRoom) => void,
    rules: MatchRules = RULE_PRESETS.assisted,
  ) {
    this.id = id;
    this.playerIds = playerIds;
    this.turnSeconds = turnSeconds;
    this.game = new Game(createGameState(playerIds.length, undefined, rules));
  }

  indexOf(sessionId: string): PlayerIndex | -1 {
    const index = this.playerIds.indexOf(sessionId);
    return index === -1 ? -1 : index;
  }

  /** ผู้เล่นคนอื่นทั้งหมดในเกมนี้ */
  othersOf(sessionId: string): string[] {
    return this.playerIds.filter((id) => id !== sessionId);
  }

  armTimer(): void {
    this.clearTimer();
    if (this.turnSeconds <= 0 || !this.game.isActive) {
      this.deadline = null;
      return;
    }
    this.deadline = Date.now() + this.turnSeconds * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout(this);
    }, this.turnSeconds * 1000);
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  /**
   * ล้างคำขอจบเกม — ต้องล้างทั้งผู้ขอและโหวตพร้อมกันเสมอ
   * ก่อนหน้านี้บางเส้นทางล้างแต่ endOfferBy ทำให้โหวตเก่าค้างและ client เห็นตัวเลขผิด
   */
  clearEndOffer(): void {
    this.endOfferBy = null;
    this.endVotes.clear();
  }

  scheduleBot(delayMs: number, step: () => void): void {
    if (this.botTimer) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      step();
    }, delayMs);
  }

  clearBot(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.botPlan = null;
    this.botStep = 0;
  }

  /**
   * ปลายทางที่ถูกกติกาของหมากที่ถูกเลือกอยู่ตอนนี้
   *
   * โหมดที่ไม่ช่วยชี้เป้าจะไม่ส่งข้อมูลนี้ออกไปเลย ไม่ใช่แค่ให้ client ไม่วาด —
   * ไม่งั้นเปิด devtools ดูก็เห็นคำตอบหมด
   */
  private targets(): { kind: "capture" | "move" | "none"; squares: number[] } {
    const selection = this.game.state.selection;
    if (!selection || !this.game.isActive) return { kind: "none", squares: [] };
    if (this.game.state.rules.assist !== "full") return { kind: "none", squares: [] };
    if (selection.kind === "capture") {
      return { kind: "capture", squares: analyzeCaptures(this.game.board, selection.at).steps.map((s) => s.to) };
    }
    return { kind: "move", squares: moveDestinations(this.game.board, selection.at) };
  }

  stateView(players: PublicPlayer[], endVotesNeeded = players.length): StateView {
    const state = this.game.state;
    const target = this.targets();
    const selection = state.selection;
    const history = state.history;

    return {
      matchId: this.id,
      board: state.board.map((cell) => (cell === null ? -1 : cell)),
      playerCount: state.playerCount,
      scores: [...state.scores],
      retired: [...state.retired],
      current: state.current,
      turn: state.turn,
      status: state.status,
      selection: selection
        ? {
            origin: selection.origin,
            at: selection.at,
            pieceId: selection.pieceId,
            kind: selection.kind,
            path: [...selection.path],
            capturedSquares: [...selection.capturedSquares],
            requiredCaptures: selection.requiredCaptures,
            capturesSoFar: selection.capturesSoFar,
            // จำนวนที่กินได้จริงเป็นคำใบ้ชั้นดี โหมดที่ไม่ช่วยจึงไม่บอก
            availableCaptures: state.rules.assist === "full" ? selection.availableCaptures : null,
          }
        : null,
      rules: { ...state.rules },
      canEndTurn: this.game.canEndTurn(),
      selectable: state.rules.assist === "none" ? [] : this.game.selectable(),
      targets: target.squares,
      targetKind: target.kind,
      lastTurn: history.length > 0 ? history[history.length - 1] : null,
      noCaptureStreak: state.noCaptureStreak,
      noCaptureLimit: state.noCaptureLimit,
      turnSeconds: this.turnSeconds,
      deadline: this.deadline,
      now: Date.now(),
      players,
      endOfferBy: this.endOfferBy,
      endVotes: [...this.endVotes],
      endVotesNeeded,
      autopilot: [...this.autopilot.keys()],
      stateHash: hashState(state.board, state.scores, state.turn, state.current),
    };
  }
}

/** FNV-1a อย่างง่าย ใช้ตรวจ desync ระหว่าง client กับ server (ดู §29) */
export function hashState(
  board: (number | null)[],
  scores: readonly number[],
  turn: number,
  current: number,
): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const cell of board) mix(cell === null ? 255 : cell);
  for (const score of scores) mix(score);
  mix(turn);
  mix(current);
  return hash.toString(16).padStart(8, "0");
}
