/**
 * กระดานของหมากสี่กระดาน
 *
 * กระดาน 8x8 = 64 ช่อง โดยช่องกลาง 4 ช่องเป็น "ช่องว่างเริ่มต้น"
 * จึงเริ่มเกมด้วยหมาก 60 ตัวบนอีก 60 ช่อง และมีช่องว่างให้กระโดดลงได้ทันที
 *
 * ช่องถูกอ้างอิงด้วย index เดียว: i = r * 8 + c  (r = 0 คือแถวบนสุด)
 */

export const SIZE = 8;
export const CELLS = SIZE * SIZE;

/** ช่องกลาง 4 ช่อง: (3,3) (3,4) (4,3) (4,4) แบบ 0-indexed */
export const CENTER_HOLES: readonly number[] = [27, 28, 35, 36];

export const PIECE_COUNT = CELLS - CENTER_HOLES.length; // 60

/** null = ช่องว่าง, number = piece id ของหมากที่อยู่บนช่องนั้น */
export type Board = (number | null)[];

export interface Dir {
  readonly dr: number;
  readonly dc: number;
  /** สัญลักษณ์ไว้ใช้ใน log / debug */
  readonly glyph: string;
}

/** 8 ทิศทาง: แนว + และแนว X */
export const DIRS: readonly Dir[] = [
  { dr: -1, dc: 0, glyph: "↑" },
  { dr: 1, dc: 0, glyph: "↓" },
  { dr: 0, dc: -1, glyph: "←" },
  { dr: 0, dc: 1, glyph: "→" },
  { dr: -1, dc: -1, glyph: "↖" },
  { dr: -1, dc: 1, glyph: "↗" },
  { dr: 1, dc: -1, glyph: "↙" },
  { dr: 1, dc: 1, glyph: "↘" },
];

export const idx = (r: number, c: number): number => r * SIZE + c;
export const rowOf = (i: number): number => (i / SIZE) | 0;
export const colOf = (i: number): number => i % SIZE;

/**
 * เดินจากช่อง i ไปตามทิศ d เป็นจำนวน n ก้าว
 * คืน -1 ถ้าหลุดขอบกระดาน
 */
export function shift(i: number, d: Dir, n = 1): number {
  const r = rowOf(i) + d.dr * n;
  const c = colOf(i) + d.dc * n;
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return -1;
  return idx(r, c);
}

/** กระดานเริ่มต้น: หมาก 60 ตัว (id 0..59) เว้นช่องกลาง 4 ช่อง */
export function initialBoard(): Board {
  const holes = new Set(CENTER_HOLES);
  const board: Board = new Array(CELLS).fill(null);
  let id = 0;
  for (let i = 0; i < CELLS; i++) {
    if (!holes.has(i)) board[i] = id++;
  }
  return board;
}

/** ตำแหน่งแบบอ่านง่าย เช่น 12 -> "e7" */
export function squareLabel(i: number): string {
  return `${"abcdefgh"[colOf(i)]}${SIZE - rowOf(i)}`;
}

export function findPiece(board: Board, pieceId: number): number {
  return board.indexOf(pieceId);
}

export function countPieces(board: Board): number {
  let n = 0;
  for (const cell of board) if (cell !== null) n++;
  return n;
}
