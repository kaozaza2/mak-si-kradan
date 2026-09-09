/**
 * AI ของหมากสี่กระดาน — pure ทั้งหมด ไม่รู้จัก server เช่นเดียวกับส่วนอื่นของ engine
 *
 * เกมนี้เป็น score war บนกระดานที่หมากเป็นของกลาง การประเมินจึงไม่ใช่ "ใครได้เปรียบพื้นที่"
 * แต่เป็น "ตาต่อ ๆ ไปใครจะกินได้มากกว่ากัน" ตัวค้นหาจึงเป็น negamax บนผลต่างจำนวนที่กิน
 * โดยตรง และเพราะกระดานเป็นของกลาง ท่าที่ดีจึงต้องดูด้วยว่าหลังเดินแล้ว "เปิดทาง" ให้คู่แข่ง
 * กินต่อหรือเปล่า (§12)
 */

import { type Board, colOf, idx, rowOf } from "./board.js";
import type { GameState } from "./game.js";
import { analyzeCaptures, moveDestinations, selectableSquares } from "./rules.js";

export type AiLevel = "easy" | "normal" | "hard";

export interface AiMove {
  /** ช่องของหมากที่เลือก */
  from: number;
  kind: "capture" | "move";
  /** ช่องที่ลงในแต่ละก้าว (ไม่รวมช่องเริ่มต้น) */
  path: number[];
  captures: number;
}

export interface AiOptions {
  random?: () => number;
  /** เพดานเวลาคิดต่อหนึ่งตา (ms) */
  timeBudgetMs?: number;
}

interface LevelConfig {
  depth: number;
  rootWidth: number;
  width: number;
  chainsPerPiece: number;
  /**
   * น้ำหนักของ "ภัยคุกคามที่ปลายการค้นหา" — ที่ปลายทางฝ่ายที่ถึงตายังกินต่อได้อีกเท่าไร
   *
   * ในเกมนี้ตัวนี้สำคัญกว่าการค้นหาให้ลึก จากการทดลองให้บอทเล่นกันเอง
   * การเพิ่มความลึกเป็น 4 ply กลับ *แพ้* 2 ply เพราะท่าเดินเปล่า (ไม่กิน) มีเป็นร้อยท่า
   * การตัดกิ่งให้แคบพอจะค้นลึกได้จึงทำให้มองข้ามท่าที่ปลอดภัยจริง ๆ ไป
   * ส่วนการเติมค่าภัยคุกคามที่ปลายทางชนะรุ่นที่ไม่มีถึง 11/12 เกม
   */
  threatWeight: number;
  timeBudgetMs: number;
}

const LEVELS: Record<AiLevel, LevelConfig> = {
  easy: { depth: 0, rootWidth: 999, width: 0, chainsPerPiece: 1, threatWeight: 0, timeBudgetMs: 50 },
  normal: { depth: 2, rootWidth: 16, width: 8, chainsPerPiece: 2, threatWeight: 0, timeBudgetMs: 400 },
  hard: { depth: 2, rootWidth: 64, width: 16, chainsPerPiece: 2, threatWeight: 0.5, timeBudgetMs: 800 },
};

export const AI_LEVEL_NAMES: Record<AiLevel, string> = {
  easy: "ง่าย",
  normal: "ปานกลาง",
  hard: "ยาก",
};

export function isAiLevel(value: unknown): value is AiLevel {
  return value === "easy" || value === "normal" || value === "hard";
}

// ── การสร้างท่าที่เป็นไปได้ ─────────────────────────────────────────────────

/** ช่องที่ถูกข้ามระหว่างกระโดดจาก `from` ไป `to` */
export function jumpedSquare(from: number, to: number): number {
  return idx((rowOf(from) + rowOf(to)) / 2, (colOf(from) + colOf(to)) / 2);
}

/**
 * เส้นทางการกินที่ยาวที่สุดทั้งหมดของหมากที่ช่อง `from`
 * ทุกเส้นทางกินได้เท่ากัน (ตามกติกา Maximum Capture) แต่หมากไปจบคนละที่
 * ซึ่งสำคัญมากในเกมนี้เพราะตำแหน่งปลายทางคืออาวุธที่ส่งต่อให้คู่แข่ง
 */
export function maxCaptureChains(board: Board, from: number, limit = 3): number[][] {
  const analysis = analyzeCaptures(board, from);
  if (analysis.max === 0 || limit <= 0) return [];

  const paths: number[][] = [];
  for (const step of analysis.steps) {
    const next = board.slice();
    const piece = next[from]!;
    next[from] = null;
    next[step.over] = null;
    next[step.to] = piece;

    const tails = maxCaptureChains(next, step.to, limit - paths.length);
    if (tails.length === 0) paths.push([step.to]);
    else for (const tail of tails) {
      paths.push([step.to, ...tail]);
      if (paths.length >= limit) break;
    }
    if (paths.length >= limit) break;
  }
  return paths;
}

/** ท่าที่ถูกกติกาทั้งหมดบนกระดานนี้ (หมากเป็นของกลาง จึงเป็นท่าของ "ฝ่ายที่ถึงตา" เสมอ) */
export function generateMoves(board: Board, chainsPerPiece = 3): AiMove[] {
  const moves: AiMove[] = [];
  for (const from of selectableSquares(board)) {
    const chains = maxCaptureChains(board, from, chainsPerPiece);
    if (chains.length > 0) {
      for (const path of chains) moves.push({ from, kind: "capture", path, captures: path.length });
      continue;
    }
    for (const to of moveDestinations(board, from)) {
      moves.push({ from, kind: "move", path: [to], captures: 0 });
    }
  }
  return moves;
}

export function applyMoveToBoard(board: Board, move: AiMove): Board {
  const next = board.slice();
  const piece = next[move.from]!;
  let at = move.from;
  for (const to of move.path) {
    if (move.kind === "capture") next[jumpedSquare(at, to)] = null;
    next[at] = null;
    next[to] = piece;
    at = to;
  }
  return next;
}

// ── การค้นหา ────────────────────────────────────────────────────────────────

interface SearchContext {
  deadline: number;
  config: LevelConfig;
  nodes: number;
}

/**
 * negamax + alpha-beta บน "ผลต่างจำนวนหมากที่กินได้" จากมุมมองฝ่ายที่ถึงตา
 * ค่าที่คืนคือกำไรสุทธิที่คาดว่าจะได้ในช่วง depth ที่มองเห็น
 */
function search(board: Board, depth: number, alpha: number, beta: number, context: SearchContext): number {
  if (depth <= 0 || Date.now() > context.deadline) return leafValue(board, context.config);

  const moves = orderMoves(generateMoves(board, context.config.chainsPerPiece)).slice(0, context.config.width);
  if (moves.length === 0) return 0;

  let best = -Infinity;
  for (const move of moves) {
    context.nodes++;
    const value = move.captures - search(applyMoveToBoard(board, move), depth - 1, -beta, -alpha, context);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
    if (Date.now() > context.deadline) break;
  }
  return best === -Infinity ? 0 : best;
}

function orderMoves(moves: AiMove[]): AiMove[] {
  return [...moves].sort((a, b) => b.captures - a.captures);
}

/** จำนวนที่ฝ่ายถึงตากินได้ทันทีบนกระดานนี้ ใช้เป็นค่าประเมินที่ปลายการค้นหา */
export function bestImmediateCapture(board: Board): number {
  let best = 0;
  for (const from of selectableSquares(board)) {
    const max = analyzeCaptures(board, from).max;
    if (max > best) best = max;
  }
  return best;
}

function leafValue(board: Board, config: LevelConfig): number {
  return config.threatWeight === 0 ? 0 : config.threatWeight * bestImmediateCapture(board);
}

/** เลือกท่าที่จะเล่นสำหรับ state ปัจจุบัน คืน null ถ้าไม่มีท่าที่เล่นได้ */
export function chooseMove(state: GameState, level: AiLevel = "normal", options: AiOptions = {}): AiMove | null {
  const random = options.random ?? Math.random;
  const config = LEVELS[level];
  const moves = generateMoves(state.board, config.chainsPerPiece);
  if (moves.length === 0) return null;

  if (level === "easy") return pickEasy(moves, random);

  const context: SearchContext = {
    deadline: Date.now() + (options.timeBudgetMs ?? config.timeBudgetMs),
    config,
    nodes: 0,
  };

  const candidates = orderMoves(moves).slice(0, config.rootWidth);
  let best: AiMove[] = [];
  let bestValue = -Infinity;

  for (const move of candidates) {
    const value = move.captures - search(applyMoveToBoard(state.board, move), config.depth - 1, -Infinity, Infinity, context);
    if (value > bestValue + 1e-9) {
      bestValue = value;
      best = [move];
    } else if (Math.abs(value - bestValue) < 1e-9) {
      best.push(move);
    }
  }

  // ท่าที่ดีเท่ากันให้สุ่ม เพื่อไม่ให้บอทเล่นซ้ำรูปเดิมทุกเกม
  return best.length > 0 ? best[Math.floor(random() * best.length)] : candidates[0];
}

function pickEasy(moves: AiMove[], random: () => number): AiMove {
  const capturing = moves.filter((move) => move.captures > 0);
  // มองเห็นการกินตรงหน้าเป็นส่วนใหญ่ แต่ไม่คิดต่อว่าจะเปิดทางให้คู่แข่งหรือเปล่า
  if (capturing.length > 0 && random() < 0.75) {
    const bestCount = Math.max(...capturing.map((move) => move.captures));
    const best = capturing.filter((move) => move.captures === bestCount);
    return best[Math.floor(random() * best.length)];
  }
  return moves[Math.floor(random() * moves.length)];
}
