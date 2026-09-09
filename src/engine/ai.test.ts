import { describe, expect, test } from "bun:test";
import {
  type AiLevel,
  type AiMove,
  Game,
  applyMoveToBoard,
  bestImmediateCapture,
  chooseMove,
  countPieces,
  createGameState,
  generateMoves,
  idx,
  initialBoard,
  isAiLevel,
  jumpedSquare,
  maxCaptureChains,
} from "./index.js";

/** RNG แบบกำหนด seed ได้ เพื่อให้ผลการทดสอบซ้ำได้ */
function seeded(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** เดินท่าของบอทผ่าน Game Engine จริง — ถ้าท่าผิดกติกา ตรงนี้จะพัง */
function playMove(game: Game, move: AiMove): void {
  expect(game.select(move.from).ok).toBe(true);
  for (const to of move.path) {
    const result = move.kind === "capture" ? game.captureTo(to) : game.moveTo(to);
    expect(result.ok).toBe(true);
  }
}

function playGame(a: AiLevel, b: AiLevel, seed: number): number[] {
  const game = new Game();
  const random = seeded(seed);
  let guard = 0;
  while (game.isActive && guard++ < 300) {
    const move = chooseMove(game.state, game.state.current === 0 ? a : b, { random });
    if (!move) break;
    playMove(game, move);
  }
  return game.state.scores;
}

describe("การสร้างท่าของ AI", () => {
  test("ท่าทั้งหมดบนกระดานเริ่มต้นถูกกติกาและเดินได้จริง", () => {
    const board = initialBoard();
    const moves = generateMoves(board);
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(move.path.length).toBeGreaterThan(0);
      expect(move.captures).toBe(move.kind === "capture" ? move.path.length : 0);
      const game = new Game();
      playMove(game, move);
    }
  });

  test("maxCaptureChains คืนเฉพาะเส้นทางที่ยาวที่สุด", () => {
    const state = createGameState();
    state.board = new Array(64).fill(null);
    // จาก (4,0): ขึ้นบนกินได้ 1 / ไปขวากินได้ 3
    for (const square of [idx(4, 0), idx(3, 0), idx(4, 1), idx(4, 3), idx(4, 5)]) state.board[square] = square;
    const chains = maxCaptureChains(state.board, idx(4, 0));
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) expect(chain.length).toBe(3);
    expect(chains[0]).toEqual([idx(4, 2), idx(4, 4), idx(4, 6)]);
  });

  test("applyMoveToBoard ให้กระดานตรงกับที่ engine เดินจริง", () => {
    const game = new Game();
    const move = generateMoves(game.board).find((m) => m.captures > 0)!;
    const predicted = applyMoveToBoard(game.board, move);
    playMove(game, move);
    expect(game.board).toEqual(predicted);
    expect(countPieces(predicted)).toBe(60 - move.captures);
  });

  test("jumpedSquare หาช่องที่ถูกข้ามได้ถูกต้องทุกทิศ", () => {
    expect(jumpedSquare(idx(4, 4), idx(4, 6))).toBe(idx(4, 5));
    expect(jumpedSquare(idx(4, 4), idx(2, 2))).toBe(idx(3, 3));
    expect(jumpedSquare(idx(4, 4), idx(6, 6))).toBe(idx(5, 5));
  });

  test("bestImmediateCapture บอกจำนวนที่ฝ่ายถึงตากินได้ทันที", () => {
    expect(bestImmediateCapture(initialBoard())).toBe(1);
    const empty = new Array(64).fill(null);
    expect(bestImmediateCapture(empty)).toBe(0);
  });
});

describe("การตัดสินใจของ AI", () => {
  test("ทุกระดับคืนท่าที่ถูกกติกาเสมอตลอดทั้งเกม", () => {
    for (const level of ["easy", "normal", "hard"] as const) {
      const game = new Game();
      const random = seeded(99);
      let guard = 0;
      while (game.isActive && guard++ < 200) {
        const move = chooseMove(game.state, level, { random });
        if (!move) break;
        playMove(game, move); // playMove จะ assert ว่าทุกก้าวถูกกติกา
      }
      expect(game.state.turn).toBeGreaterThan(10);
    }
  });

  test("เลือกหมากที่กินได้มากที่สุดของทั้งกระดาน ไม่ใช่แค่ตัวที่เห็นก่อน", () => {
    const state = createGameState();
    state.board = new Array(64).fill(null);
    for (const square of [idx(4, 0), idx(3, 0), idx(4, 1), idx(4, 3), idx(4, 5)]) state.board[square] = square;

    // หมากที่ a4 กินตรงไปทางขวาได้ 3 แต่หมากที่ a5 ซิกแซกได้ถึง 4 (นี่คือประเด็นของ §10)
    const best = Math.max(...generateMoves(state.board).map((move) => move.captures));
    expect(best).toBe(4);
    for (const level of ["normal", "hard"] as const) {
      const move = chooseMove(state, level, { random: seeded(1) })!;
      expect(move.captures).toBe(4);
    }
  });

  test("hard เลี่ยงท่าที่เปิดทางให้คู่แข่งกินยาว", () => {
    // กินได้ 1 สองทาง: ทางหนึ่งไปจอดให้คู่แข่งกินต่อได้ อีกทางไม่เปิดอะไรเลย
    const state = createGameState();
    state.board = new Array(64).fill(null);
    for (const square of [idx(0, 0), idx(0, 1), idx(7, 0), idx(6, 0), idx(4, 4), idx(5, 5)]) {
      state.board[square] = square;
    }
    const move = chooseMove(state, "hard", { random: seeded(5) })!;
    const after = applyMoveToBoard(state.board, move);
    const alternatives = generateMoves(state.board).filter((m) => m.captures === move.captures);
    const worst = Math.max(...alternatives.map((m) => bestImmediateCapture(applyMoveToBoard(state.board, m))));
    expect(bestImmediateCapture(after)).toBeLessThanOrEqual(worst);
  });

  test("ไม่มีท่าให้เล่นก็คืน null", () => {
    const state = createGameState();
    state.board = new Array(64).fill(null);
    expect(chooseMove(state, "hard")).toBeNull();
  });

  test("isAiLevel กันค่าที่ไม่ถูกต้อง", () => {
    expect(isAiLevel("hard")).toBe(true);
    expect(isAiLevel("impossible")).toBe(false);
    expect(isAiLevel(undefined)).toBe(false);
  });
});

describe("ความแรงของแต่ละระดับ", () => {
  test("hard ชนะ easy และ normal ชนะ easy", () => {
    let hardWins = 0;
    let normalWins = 0;
    for (let seed = 0; seed < 4; seed++) {
      const [hard, easyA] = playGame("hard", "easy", seed);
      if (hard > easyA) hardWins++;
      const [normal, easyB] = playGame("normal", "easy", seed + 100);
      if (normal > easyB) normalWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(3);
    expect(normalWins).toBeGreaterThanOrEqual(3);
  });

  test("คิดหนึ่งตาไม่เกิน 200ms แม้ระดับยาก", () => {
    const game = new Game();
    let worst = 0;
    for (let i = 0; i < 20 && game.isActive; i++) {
      const started = performance.now();
      const move = chooseMove(game.state, "hard", { random: seeded(7) });
      worst = Math.max(worst, performance.now() - started);
      if (!move) break;
      playMove(game, move);
    }
    expect(worst).toBeLessThan(200);
  });
});
