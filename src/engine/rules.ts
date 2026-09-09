/**
 * กติกาการเดินและการกิน — pure functions ทั้งหมด
 *
 * หลักการ:
 *  - หมากทุกตัวเป็นกลาง ไม่มีเจ้าของ ใครถึงเทิร์นเลือกหมากตัวใดก็ได้
 *  - กิน = กระโดดข้ามหมาก 1 ตัวไปยังช่องถัดไปที่ต้องว่าง (8 ทิศ)
 *  - กินต่อเนื่องได้ และเปลี่ยนทิศระหว่าง chain ได้
 *  - เมื่อเลือกหมากแล้ว ต้องเดิน chain ที่กินได้ "มากที่สุด" ของหมากตัวนั้น
 *  - ถ้าหมากที่เลือกกินไม่ได้เลย จึงเดินปกติ 1 ช่องได้ (8 ทิศ) แล้วจบเทิร์น
 */

import { type Board, type Dir, DIRS, shift } from "./board.js";

export interface CaptureStep {
  /** ช่องต้นทางของก้าวนี้ */
  from: number;
  /** ช่องของหมากที่ถูกข้าม (จะถูกกินออกจากกระดาน) */
  over: number;
  /** ช่องปลายทาง (ต้องว่าง) */
  to: number;
  /** piece id ของหมากที่ถูกกิน */
  capturedPiece: number;
  dir: Dir;
}

/**
 * เพดานจำนวน node ของการค้นหา chain กันกรณีกระดานที่แตกแขนงมหาศาล
 * ในทางปฏิบัติของกระดาน 8x8 แทบไม่มีทางแตะเพดานนี้
 */
const SEARCH_NODE_BUDGET = 2_000_000;

/** ก้าวการกินที่เป็นไปได้ทั้งหมดจากช่อง `from` (1 ก้าว ไม่ดู chain) */
export function captureStepsFrom(board: Board, from: number): CaptureStep[] {
  const steps: CaptureStep[] = [];
  if (board[from] === null) return steps;
  for (const dir of DIRS) {
    const over = shift(from, dir, 1);
    if (over < 0) continue;
    const to = shift(from, dir, 2);
    if (to < 0) continue;
    const captured = board[over];
    if (captured === null) continue;
    if (board[to] !== null) continue;
    steps.push({ from, over, to, capturedPiece: captured, dir });
  }
  return steps;
}

/** ค้นหาความยาว chain สูงสุดจากช่อง `from` (mutate/undo บน board ที่ให้มา) */
function searchMaxChain(board: Board, from: number, budget: { n: number }): number {
  let best = 0;
  const piece = board[from];
  if (piece === null) return 0;
  for (const dir of DIRS) {
    if (budget.n <= 0) break;
    const over = shift(from, dir, 1);
    if (over < 0) continue;
    const to = shift(from, dir, 2);
    if (to < 0) continue;
    const captured = board[over];
    if (captured === null || board[to] !== null) continue;

    budget.n--;
    board[from] = null;
    board[over] = null;
    board[to] = piece;
    const depth = 1 + searchMaxChain(board, to, budget);
    board[to] = null;
    board[over] = captured;
    board[from] = piece;

    if (depth > best) best = depth;
  }
  return best;
}

export interface CaptureAnalysis {
  /** จำนวนหมากสูงสุดที่หมากตัวนี้กินได้ใน 1 เทิร์น (0 = กินไม่ได้) */
  max: number;
  /** ก้าวแรกที่ "ยังคงพา chain ไปถึงค่าสูงสุด" ได้เท่านั้น */
  steps: CaptureStep[];
}

/**
 * วิเคราะห์การกินของหมากที่ช่อง `from`
 * คืนค่า max = ความยาว chain สูงสุด และ steps = ก้าวถัดไปที่ถูกกติกา
 * (กติกา Maximum Capture: ต้องเลือกก้าวที่ยังไปถึง max ได้เท่านั้น)
 */
export function analyzeCaptures(board: Board, from: number): CaptureAnalysis {
  const first = captureStepsFrom(board, from);
  if (first.length === 0) return { max: 0, steps: [] };

  const work = board.slice();
  const piece = work[from]!;
  const budget = { n: SEARCH_NODE_BUDGET };
  const depths: number[] = [];
  let max = 0;

  for (const step of first) {
    work[from] = null;
    work[step.over] = null;
    work[step.to] = piece;
    const depth = 1 + searchMaxChain(work, step.to, budget);
    work[step.to] = null;
    work[step.over] = step.capturedPiece;
    work[from] = piece;

    depths.push(depth);
    if (depth > max) max = depth;
  }

  return { max, steps: first.filter((_, i) => depths[i] === max) };
}

/** ช่องปลายทางของการเดินปกติ: 1 ช่อง 8 ทิศ ไปยังช่องที่ว่าง */
export function moveDestinations(board: Board, from: number): number[] {
  const dests: number[] = [];
  if (board[from] === null) return dests;
  for (const dir of DIRS) {
    const to = shift(from, dir, 1);
    if (to >= 0 && board[to] === null) dests.push(to);
  }
  return dests;
}

export type PieceOptions =
  | { kind: "capture"; max: number; steps: CaptureStep[] }
  | { kind: "move"; destinations: number[] }
  | { kind: "none" };

/**
 * ตัวเลือกทั้งหมดของหมากที่ช่อง `from`
 * ถ้ากินได้ ต้องกิน (และต้องกินให้ได้มากที่สุด) — เดินปกติไม่ได้
 */
export function pieceOptions(board: Board, from: number): PieceOptions {
  if (from < 0 || from >= board.length || board[from] === null) return { kind: "none" };
  const captures = analyzeCaptures(board, from);
  if (captures.max > 0) return { kind: "capture", max: captures.max, steps: captures.steps };
  const destinations = moveDestinations(board, from);
  if (destinations.length > 0) return { kind: "move", destinations };
  return { kind: "none" };
}

/** หมากตัวนี้มีอะไรให้ทำไหม (กินได้ หรืออย่างน้อยขยับได้) */
export function pieceHasAction(board: Board, from: number): boolean {
  if (board[from] === null) return false;
  if (moveDestinations(board, from).length > 0) return true;
  return captureStepsFrom(board, from).length > 0;
}

/** ทุกช่องที่ผู้เล่นหยิบมาเล่นได้ในเทิร์นนี้ */
export function selectableSquares(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== null && pieceHasAction(board, i)) out.push(i);
  }
  return out;
}

/** ยังมีการเล่นที่ถูกต้องเหลืออยู่ไหม (ใช้เป็นเงื่อนไขจบเกม) */
export function hasAnyLegalAction(board: Board): boolean {
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== null && pieceHasAction(board, i)) return true;
  }
  return false;
}
