/**
 * Game Engine ของหมากสี่กระดาน
 *
 * ไม่รู้จัก HTTP / WebSocket / user account ใด ๆ ทั้งสิ้น (ดู §34 ของ concept)
 * ทำให้เอาไปใช้กับ server, unit test, AI, replay หรือ offline mode ได้เหมือนกันหมด
 *
 * รองรับ 2–4 ผู้เล่น เพราะหมากเป็นของกลางอยู่แล้ว การเพิ่มผู้เล่นจึงเป็นแค่การ
 * เพิ่มคิวในลำดับเทิร์น ไม่ต้องแตะกติกาการกินเลย
 */

import { type Board, countPieces, findPiece, initialBoard, squareLabel } from "./board.js";
import type { ActionResult, ErrorParams, GameErrorCode } from "./errors.js";
import {
  type CaptureStep,
  analyzeCaptures,
  captureStepsFrom,
  hasAnyLegalAction,
  moveDestinations,
  pieceOptions,
  selectableSquares,
} from "./rules.js";

/** ลำดับที่นั่งของผู้เล่น 0..playerCount-1 */
export type PlayerIndex = number;

export type EndReason = "no_legal_moves" | "exhaustion" | "agreement" | "resign" | "timeout";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/**
 * จำนวนเทิร์นติดต่อกันที่ไม่มีการกินเลย ก่อนจะถือว่ากระดานตัน
 *
 * จำเป็นเพราะหมากตัวเดียวก็ยังเดินปกติได้เสมอ เงื่อนไข "ไม่มีการเล่นที่ถูกต้องเหลือ"
 * เพียงอย่างเดียวจึงแทบไม่มีทางเกิดขึ้น และเกมจะยืดไปได้ไม่รู้จบ
 */
export const DEFAULT_NO_CAPTURE_LIMIT = 20;

/**
 * ระดับที่เกมช่วยชี้เป้าให้ — server ตัดข้อมูลออกจาก state จริง ๆ
 * ไม่ใช่แค่ client เลือกไม่วาด ไม่งั้นแกะจาก devtools ก็โกงได้
 */
export type AssistLevel = "full" | "pieces" | "none";

/**
 * กติกาที่ปรับได้ของหนึ่ง match
 *
 * แยกเป็นสองแกนที่ไม่เกี่ยวกัน: กติกา "บังคับ" แค่ไหน กับเกม "ช่วยชี้เป้า" แค่ไหน
 * การผ่อนสองอย่างนี้คือสิ่งที่ทำให้ความผิดพลาดแบบกระดานจริงเกิดขึ้นได้ —
 * ลืมกินต่อ กินไม่ครบ หรือหาจุดกินไม่เจอจนเดินหมากเปล่าแทน
 */
export interface MatchRules {
  /** หมากที่กินได้ ต้องกิน ห้ามเดินปกติ */
  forceCapture: boolean;
  /** ต้องเดินเส้นทางที่กินได้มากที่สุด และกินจนสุด chain */
  forceMaximum: boolean;
  assist: AssistLevel;
  /** จับหมากแล้วต้องเดินตัวนั้น เปลี่ยนใจไม่ได้ */
  touchMove: boolean;
}

export type RuleMode = "assisted" | "standard" | "table";

export const RULE_PRESETS: Record<RuleMode, MatchRules> = {
  /** ตามสเปกเดิมทุกข้อ (§9) — เกมคำนวณให้หมด เหมาะกับคนเพิ่งหัดเล่น */
  assisted: { forceCapture: true, forceMaximum: true, assist: "full", touchMove: false },
  /** บอกว่าหมากตัวไหนขยับได้ แต่ไม่บอกว่าไปไหนได้บ้าง และไม่บังคับให้กินจนสุด */
  standard: { forceCapture: false, forceMaximum: false, assist: "pieces", touchMove: true },
  /** ไม่ช่วยอะไรเลย เหมือนนั่งอยู่หน้ากระดานจริง */
  table: { forceCapture: false, forceMaximum: false, assist: "none", touchMove: true },
};

export const RULE_MODE_NAMES: Record<RuleMode, string> = {
  assisted: "ช่วยคำนวณ",
  standard: "มาตรฐาน",
  table: "กระดานจริง",
};

export function isRuleMode(value: unknown): value is RuleMode {
  return value === "assisted" || value === "standard" || value === "table";
}

export interface SelectionState {
  pieceId: number;
  /** ช่องต้นทางตอนเริ่มเทิร์น */
  origin: number;
  /** ช่องปัจจุบันของหมากที่เลือก */
  at: number;
  kind: "capture" | "move";
  /** จำนวนหมากที่ต้องกินให้ครบตามกติกา Maximum Capture (0 = ไม่บังคับ) */
  requiredCaptures: number;
  /** จำนวนที่หมากตัวนี้กินได้สูงสุด ไม่ว่าจะบังคับหรือไม่ — ใช้คิดว่าพลาดไปเท่าไร */
  availableCaptures: number;
  /** ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร ณ ตอนที่เลือกหมาก */
  bestAvailable: number;
  capturesSoFar: number;
  path: number[];
  capturedSquares: number[];
  /** true เมื่อลงมือไปแล้ว — เปลี่ยนใจเลือกหมากตัวอื่นไม่ได้อีก */
  locked: boolean;
}

export interface TurnRecord {
  turn: number;
  player: PlayerIndex;
  pieceId: number;
  kind: "capture" | "move";
  /** [ช่องเริ่ม, ช่องที่ลงแต่ละก้าว...] */
  path: number[];
  capturedSquares: number[];
  captures: number;
  scoreDelta: number;
  /** หมากตัวที่เลือกกินได้สูงสุดเท่าไร */
  availableCaptures: number;
  /** กินได้แต่ไม่ได้กิน = คะแนนที่ทิ้งไว้ให้คู่แข่งหยิบไปต่อ */
  missedCaptures: number;
  /** ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร (เลือกหมากถูกตัวหรือเปล่า) */
  bestAvailable: number;
}

export interface GameResult {
  reason: EndReason;
  scores: number[];
  /** ผู้ชนะ — มากกว่า 1 คนคือเสมอกันที่คะแนนสูงสุด */
  winners: PlayerIndex[];
}

export interface GameState {
  playerCount: number;
  rules: MatchRules;
  board: Board;
  scores: number[];
  current: PlayerIndex;
  /** ผู้เล่นที่ถอนตัวไปแล้ว (ยอมแพ้ / ออกจากเกม) — ข้ามในลำดับเทิร์นและชนะไม่ได้ */
  retired: PlayerIndex[];
  /** เทิร์นที่กำลังเล่น เริ่มที่ 1 */
  turn: number;
  selection: SelectionState | null;
  status: "active" | "ended";
  result: GameResult | null;
  history: TurnRecord[];
  /** จำนวนเทิร์นติดต่อกันล่าสุดที่ไม่มีการกิน */
  noCaptureStreak: number;
  noCaptureLimit: number;
}

const ok: ActionResult = { ok: true };
const fail = (code: GameErrorCode, params?: ErrorParams): ActionResult => ({ ok: false, code, params });

export function createGameState(
  playerCount = MIN_PLAYERS,
  noCaptureLimit = DEFAULT_NO_CAPTURE_LIMIT,
  rules: MatchRules = RULE_PRESETS.assisted,
): GameState {
  const count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(playerCount)));
  return {
    playerCount: count,
    rules: { ...rules },
    board: initialBoard(),
    scores: new Array(count).fill(0),
    current: 0,
    retired: [],
    turn: 1,
    selection: null,
    status: "active",
    result: null,
    history: [],
    noCaptureStreak: 0,
    noCaptureLimit,
  };
}

export class Game {
  state: GameState;
  /** แคช "ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร" ต่อหนึ่งเทิร์น กันคำนวณซ้ำทุกครั้งที่คลิก */
  private bestAvailableCache: { turn: number; value: number } | null = null;

  constructor(state: GameState = createGameState()) {
    this.state = state;
  }

  static fromJSON(state: GameState): Game {
    return new Game(state);
  }

  get board(): Board {
    return this.state.board;
  }

  get isActive(): boolean {
    return this.state.status === "active";
  }

  /** ผู้เล่นที่ยังอยู่ในเกม */
  activePlayers(): PlayerIndex[] {
    const out: PlayerIndex[] = [];
    for (let i = 0; i < this.state.playerCount; i++) {
      if (!this.state.retired.includes(i)) out.push(i);
    }
    return out;
  }

  /** ช่องที่ผู้เล่นเลือกได้ตอนนี้ (ว่างเปล่าถ้ากำลังอยู่กลาง chain) */
  selectable(): number[] {
    if (!this.isActive) return [];
    if (this.state.selection?.locked) return [];
    return selectableSquares(this.state.board);
  }

  /** เลือกหมาก 1 ตัวมาเล่น */
  select(square: number): ActionResult {
    if (!this.isActive) return fail("game_ended");
    if (this.state.selection?.locked) return fail("must_finish_chain");

    const piece = this.state.board[square];
    if (piece === null || piece === undefined) return fail("empty_square");

    const options = pieceOptions(this.state.board, square);
    if (options.kind === "none") return fail("piece_stuck");

    const available = options.kind === "capture" ? options.max : 0;
    this.state.selection = {
      pieceId: piece,
      origin: square,
      at: square,
      kind: options.kind,
      requiredCaptures: this.state.rules.forceMaximum ? available : 0,
      availableCaptures: available,
      bestAvailable: this.bestAvailable(),
      capturesSoFar: 0,
      path: [square],
      capturedSquares: [],
      locked: false,
    };
    return ok;
  }

  /** ตานี้ทั้งกระดานกินได้สูงสุดเท่าไร — ใช้ดูย้อนหลังว่าเลือกหมากถูกตัวไหม */
  private bestAvailable(): number {
    if (this.bestAvailableCache?.turn === this.state.turn) return this.bestAvailableCache.value;
    let best = 0;
    for (const square of selectableSquares(this.state.board)) {
      const max = analyzeCaptures(this.state.board, square).max;
      if (max > best) best = max;
    }
    this.bestAvailableCache = { turn: this.state.turn, value: best };
    return best;
  }

  /** ยกเลิกการเลือก (ทำได้เฉพาะตอนที่ยังไม่ได้ลงมือ และโหมดไม่ได้บังคับจับแล้วเดิน) */
  clearSelection(): ActionResult {
    if (this.state.selection?.locked) return fail("already_acted");
    if (this.state.selection && this.state.rules.touchMove) {
      return fail("touch_move");
    }
    this.state.selection = null;
    return ok;
  }

  /** ตัวเลือกถัดไปของหมากที่เลือกอยู่ */
  currentOptions():
    | { kind: "capture"; max: number; steps: CaptureStep[] }
    | { kind: "move"; destinations: number[] }
    | { kind: "none" } {
    const selection = this.state.selection;
    if (!selection || !this.isActive) return { kind: "none" };
    if (selection.kind === "capture") {
      const analysis = analyzeCaptures(this.state.board, selection.at);
      return { kind: "capture", max: analysis.max, steps: analysis.steps };
    }
    return { kind: "move", destinations: moveDestinations(this.state.board, selection.at) };
  }

  /** เดิน chain การกิน 1 ก้าว ไปยังช่องปลายทาง `to` */
  captureTo(to: number): ActionResult {
    if (!this.isActive) return fail("game_ended");
    const selection = this.state.selection;
    if (!selection) return fail("no_piece_selected");
    if (selection.kind !== "capture") return fail("piece_cannot_capture");

    // บังคับ Maximum Capture = เดินได้เฉพาะก้าวที่ยังพา chain ไปถึงค่าสูงสุด
    // ไม่บังคับ = กระโดดไปทางไหนก็ได้ที่ถูกกติกา แล้วจะหยุดตรงไหนก็เรื่องของผู้เล่น
    const legalSteps = this.state.rules.forceMaximum
      ? analyzeCaptures(this.state.board, selection.at).steps
      : captureStepsFrom(this.state.board, selection.at);
    const step = legalSteps.find((candidate) => candidate.to === to);
    if (!step) {
      if (legalSteps.length === 0) return fail("no_more_captures");
      // ส่งช่องที่ลงได้ไปด้วย client จะได้บอกผู้เล่นได้โดยไม่ต้องคำนวณกติกาเอง
      const squares = legalSteps.map((candidate) => squareLabel(candidate.to));
      return fail(this.state.rules.forceMaximum ? "must_take_maximum" : "illegal_jump", { squares });
    }

    const piece = this.state.board[selection.at]!;
    this.state.board[selection.at] = null;
    this.state.board[step.over] = null;
    this.state.board[step.to] = piece;

    selection.at = step.to;
    selection.capturesSoFar += 1;
    selection.path.push(step.to);
    selection.capturedSquares.push(step.over);
    selection.locked = true;

    // กินต่อไม่ได้แล้วก็จบเทิร์นให้เลย ไม่มีอะไรให้ตัดสินใจต่อ
    // ถ้ายังกินต่อได้และไม่ได้บังคับ ก็ปล่อยให้ผู้เล่นเลือกเองว่าจะกินต่อหรือ endTurn
    if (captureStepsFrom(this.state.board, selection.at).length === 0) this.commitTurn();
    return ok;
  }

  /**
   * วางหมากลงช่องหนึ่ง แล้วให้ engine ตีความเองว่าเป็นการกินหรือการเดิน
   *
   * ตรงกับกระดานจริงที่ผู้เล่นแค่ "วางหมากลงตรงนั้น" และจำเป็นสำหรับโหมดที่ไม่ช่วยชี้เป้า
   * เพราะ client ไม่ควรรู้ล่วงหน้าด้วยซ้ำว่าช่องนั้นเป็นการกินหรือเปล่า
   */
  playTo(to: number): ActionResult {
    if (!this.isActive) return fail("game_ended");
    const selection = this.state.selection;
    if (!selection) return fail("no_piece_selected");
    const isJump = captureStepsFrom(this.state.board, selection.at).some((step) => step.to === to);
    return isJump ? this.captureTo(to) : this.moveTo(to);
  }

  /** ยังกินต่อได้และกติกาไม่ได้บังคับ — ผู้เล่นเลือกจบเทิร์นเองได้ */
  canEndTurn(): boolean {
    const selection = this.state.selection;
    if (!selection?.locked || !this.isActive) return false;
    if (this.state.rules.forceMaximum) return false;
    return captureStepsFrom(this.state.board, selection.at).length > 0;
  }

  /**
   * จบเทิร์นทั้งที่ยังกินต่อได้ — หัวใจของโหมดกระดานจริง
   * คะแนนที่ไม่ได้เก็บจะกลายเป็นของขวัญให้คู่แข่ง เพราะหมากเป็นของกลาง
   */
  endTurn(): ActionResult {
    if (!this.isActive) return fail("game_ended");
    const selection = this.state.selection;
    if (!selection) return fail("no_piece_selected");
    if (!selection.locked) return fail("nothing_played");
    if (this.state.rules.forceMaximum && captureStepsFrom(this.state.board, selection.at).length > 0) {
      return fail("chain_forced");
    }
    this.commitTurn();
    return ok;
  }

  /** เดินปกติ 1 ช่อง (ใช้ได้เฉพาะหมากที่กินไม่ได้) แล้วจบเทิร์น */
  moveTo(to: number): ActionResult {
    if (!this.isActive) return fail("game_ended");
    const selection = this.state.selection;
    if (!selection) return fail("no_piece_selected");
    if (selection.locked) return fail("already_acted");
    if (selection.kind !== "move" && this.state.rules.forceCapture) {
      return fail("must_capture");
    }
    if (!moveDestinations(this.state.board, selection.at).includes(to)) return fail("illegal_move");

    const piece = this.state.board[selection.at]!;
    this.state.board[selection.at] = null;
    this.state.board[to] = piece;

    selection.at = to;
    selection.path.push(to);
    selection.locked = true;
    this.commitTurn();
    return ok;
  }

  /**
   * เล่นแทนผู้เล่นเมื่อหมดเวลา: หยิบหมากที่กินได้มากที่สุด แล้วเดิน chain จนจบ
   * (ถ้าไม่มีใครกินได้เลย จะเดินปกติ 1 ช่อง)
   */
  playAutoTurn(): ActionResult {
    if (!this.isActive) return fail("game_ended");
    if (!this.state.selection?.locked) {
      let bestSquare = -1;
      let bestCount = -1;
      for (const square of selectableSquares(this.state.board)) {
        const options = pieceOptions(this.state.board, square);
        const count = options.kind === "capture" ? options.max : 0;
        if (count > bestCount) {
          bestCount = count;
          bestSquare = square;
        }
      }
      if (bestSquare < 0) return fail("no_legal_action");
      this.state.selection = null;
      const selected = this.select(bestSquare);
      if (!selected.ok) return selected;
    }

    while (this.isActive && this.state.selection) {
      const options = this.currentOptions();
      if (options.kind === "capture" && options.steps.length > 0) {
        this.captureTo(options.steps[0].to);
      } else if (options.kind === "move" && options.destinations.length > 0) {
        this.moveTo(options.destinations[0]);
      } else {
        break;
      }
    }
    return ok;
  }

  /**
   * ผู้เล่นถอนตัว (ยอมแพ้ / ออกจากเกม)
   *
   * ในเกม 3–4 คน ที่เหลือเล่นกันต่อได้ตามปกติ คนที่ถอนตัวแค่ถูกข้ามในลำดับเทิร์น
   * และหมดสิทธิ์ชนะ เกมจะจบก็ต่อเมื่อเหลือคนเดียว
   */
  retire(player: PlayerIndex): ActionResult {
    if (!this.isActive) return fail("game_ended");
    if (player < 0 || player >= this.state.playerCount) return fail("unknown_player");
    if (this.state.retired.includes(player)) return fail("already_retired");

    this.state.retired.push(player);
    if (this.activePlayers().length < 2) {
      this.endGame("resign");
      return ok;
    }

    if (this.state.current === player) {
      // คนที่ถอนตัวกำลังถือเทิร์นอยู่ ต้องส่งเทิร์นต่อและทิ้งการเลือกที่ค้างไว้
      this.state.selection = null;
      this.state.current = this.nextPlayer(player);
      this.state.turn += 1;
    }
    return ok;
  }

  /** จบเกมจากภายนอก เช่น โหวตจบ / หมดเวลา */
  endGame(reason: EndReason): ActionResult {
    if (!this.isActive) return fail("game_ended");
    this.state.selection = null;
    this.state.status = "ended";
    this.state.result = {
      reason,
      scores: [...this.state.scores],
      winners: winnersByScore(this.state.scores, this.state.retired),
    };
    return ok;
  }

  private nextPlayer(from: PlayerIndex): PlayerIndex {
    const count = this.state.playerCount;
    for (let step = 1; step <= count; step++) {
      const candidate = (from + step) % count;
      if (!this.state.retired.includes(candidate)) return candidate;
    }
    return from;
  }

  private commitTurn(): void {
    const selection = this.state.selection!;
    const scoreDelta = selection.capturesSoFar;
    this.state.scores[this.state.current] += scoreDelta;
    this.state.history.push({
      turn: this.state.turn,
      player: this.state.current,
      pieceId: selection.pieceId,
      kind: selection.capturesSoFar > 0 ? "capture" : "move",
      path: [...selection.path],
      capturedSquares: [...selection.capturedSquares],
      captures: selection.capturesSoFar,
      scoreDelta,
      availableCaptures: selection.availableCaptures,
      missedCaptures: Math.max(0, selection.availableCaptures - selection.capturesSoFar),
      bestAvailable: selection.bestAvailable,
    });

    this.state.noCaptureStreak = scoreDelta > 0 ? 0 : this.state.noCaptureStreak + 1;
    this.state.selection = null;
    this.state.current = this.nextPlayer(this.state.current);
    this.state.turn += 1;

    if (!hasAnyLegalAction(this.state.board)) {
      this.endGame("no_legal_moves");
    } else if (this.state.noCaptureStreak >= this.state.noCaptureLimit) {
      this.endGame("exhaustion");
    }
  }

  stats(): MatchStats {
    return computeStats(this.state);
  }
}

/** ผู้ชนะคือคนคะแนนสูงสุดในบรรดาคนที่ยังไม่ถอนตัว */
export function winnersByScore(scores: readonly number[], retired: readonly PlayerIndex[] = []): PlayerIndex[] {
  const eligible = scores.map((_, index) => index).filter((index) => !retired.includes(index));
  if (eligible.length === 0) return [];
  const best = Math.max(...eligible.map((index) => scores[index]));
  return eligible.filter((index) => scores[index] === best);
}

export interface PlayerStats {
  score: number;
  captures: number;
  turns: number;
  bestChain: number;
  /** คะแนนที่กินได้แต่ไม่ได้กิน รวมทั้งเกม */
  missedCaptures: number;
  /** จำนวนเทิร์นที่พลาดโอกาสไป */
  missedTurns: number;
  /** เทิร์นที่พลาดหนักที่สุด */
  worstMiss: { turn: number; missed: number } | null;
  /** เทิร์นที่ทำ chain ได้ดีที่สุด */
  bestChainTurn: number | null;
  bestChainPath: number[];
  retired: boolean;
}

export interface MatchStats {
  turns: number;
  piecesLeft: number;
  players: PlayerStats[];
}

export function computeStats(state: GameState): MatchStats {
  const players: PlayerStats[] = Array.from({ length: state.playerCount }, (_, index) => ({
    score: state.scores[index] ?? 0,
    captures: 0,
    turns: 0,
    bestChain: 0,
    bestChainTurn: null,
    bestChainPath: [],
    missedCaptures: 0,
    missedTurns: 0,
    worstMiss: null,
    retired: state.retired.includes(index),
  }));

  for (const record of state.history) {
    const player = players[record.player];
    if (!player) continue;
    player.turns += 1;
    player.captures += record.captures;
    if (record.captures > player.bestChain) {
      player.bestChain = record.captures;
      player.bestChainTurn = record.turn;
      player.bestChainPath = [...record.path];
    }
    const missed = record.missedCaptures ?? 0;
    if (missed > 0) {
      player.missedCaptures += missed;
      player.missedTurns += 1;
      if (!player.worstMiss || missed > player.worstMiss.missed) {
        player.worstMiss = { turn: record.turn, missed };
      }
    }
  }

  return {
    turns: state.history.length,
    piecesLeft: countPieces(state.board),
    players,
  };
}

export type { ActionResult, ErrorParams, GameErrorCode };
export { findPiece, squareLabel };
