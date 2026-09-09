import { describe, expect, test } from "bun:test";
import {
  CENTER_HOLES,
  type Board,
  DEFAULT_NO_CAPTURE_LIMIT,
  Game,
  RULE_PRESETS,
  PIECE_COUNT,
  analyzeCaptures,
  captureStepsFrom,
  countPieces,
  createGameState,
  hasAnyLegalAction,
  idx,
  initialBoard,
  moveDestinations,
  pieceOptions,
  selectableSquares,
} from "./index.js";

/** สร้างกระดานจากภาพ ASCII: 'o' = หมาก, '.' = ช่องว่าง (8 แถว x 8 ตัวอักษร) */
function boardFromAscii(rows: string[]): Board {
  expect(rows.length).toBe(8);
  const board: Board = new Array(64).fill(null);
  let id = 0;
  rows.forEach((row, r) => {
    expect(row.length).toBe(8);
    for (let c = 0; c < 8; c++) {
      if (row[c] === "o") board[idx(r, c)] = id++;
    }
  });
  return board;
}

function gameWith(rows: string[]): Game {
  const state = createGameState();
  state.board = boardFromAscii(rows);
  return new Game(state);
}

const E = "........";

describe("กระดานเริ่มต้น", () => {
  test("มีหมาก 60 ตัว และช่องกลาง 4 ช่องว่าง", () => {
    const board = initialBoard();
    expect(countPieces(board)).toBe(60);
    expect(PIECE_COUNT).toBe(60);
    for (const hole of CENTER_HOLES) expect(board[hole]).toBeNull();
  });

  test("เปิดเกมแล้วมีการเล่นที่ถูกต้อง ไม่ใช่กระดานตายตั้งแต่เทิร์นแรก", () => {
    const board = initialBoard();
    expect(hasAnyLegalAction(board)).toBe(true);
    const selectable = selectableSquares(board);
    // ช่องกลาง 4 ช่องเปิดทางให้: 20 ตัวที่กระโดดลงไปกินได้ + 12 ตัวรอบ ๆ ที่ขยับลงไปได้
    const capturers = selectable.filter((s) => pieceOptions(board, s).kind === "capture");
    const movers = selectable.filter((s) => pieceOptions(board, s).kind === "move");
    expect(selectable.length).toBe(32);
    expect(capturers.length).toBe(20);
    expect(movers.length).toBe(12);
  });

  test("เทิร์นแรกกินได้สูงสุด 1 ตัวเสมอ (ยังไม่มีช่องว่างพอให้ต่อ chain)", () => {
    const board = initialBoard();
    for (const square of selectableSquares(board)) {
      expect(analyzeCaptures(board, square).max).toBeLessThanOrEqual(1);
    }
  });
});

describe("การกินพื้นฐาน", () => {
  test("กระโดดข้ามหมาก 1 ตัวไปช่องว่างถัดไป ได้ 1 คะแนน และจบเทิร์น", () => {
    const game = gameWith(["oo......", E, E, E, E, E, E, E]);
    expect(game.select(idx(0, 0)).ok).toBe(true);
    expect(game.captureTo(idx(0, 2)).ok).toBe(true);
    expect(game.state.board[idx(0, 0)]).toBeNull();
    expect(game.state.board[idx(0, 1)]).toBeNull();
    expect(game.state.board[idx(0, 2)]).not.toBeNull();
    expect(game.state.scores).toEqual([1, 0]);
    expect(game.state.current).toBe(1);
  });

  test("กินได้ครบ 8 ทิศ ทั้งแนว + และแนว X", () => {
    const board = boardFromAscii([E, E, "..ooo...", "..ooo...", "..ooo...", E, E, E]);
    const steps = captureStepsFrom(board, idx(3, 3));
    expect(steps.length).toBe(8);
    expect(new Set(steps.map((s) => s.dir.glyph))).toEqual(
      new Set(["↑", "↓", "←", "→", "↖", "↗", "↙", "↘"]),
    );
  });

  test("กินไม่ได้ถ้าช่องปลายทางไม่ว่าง", () => {
    const board = boardFromAscii([E, E, "..ooo...", "..ooo...", "..ooo...", E, E, E]);
    expect(analyzeCaptures(board, idx(2, 2)).max).toBe(0);
    expect(pieceOptions(board, idx(2, 2)).kind).toBe("move");
  });
});

describe("Multi-capture", () => {
  test("กินต่อเนื่องในแนวเดียว ได้ 2 คะแนนในเทิร์นเดียว", () => {
    // ● ○ . ○ .
    const game = gameWith(["oo.o....", E, E, E, E, E, E, E]);
    expect(game.select(idx(0, 0)).ok).toBe(true);
    expect(game.state.selection!.requiredCaptures).toBe(2);
    expect(game.captureTo(idx(0, 2)).ok).toBe(true);
    expect(game.state.current).toBe(0); // ยังไม่จบเทิร์น ต้องกินต่อ
    expect(game.captureTo(idx(0, 4)).ok).toBe(true);
    expect(game.state.scores).toEqual([2, 0]);
    expect(game.state.current).toBe(1);
    expect(game.state.history[0].captures).toBe(2);
    expect(game.state.history[0].path).toEqual([idx(0, 0), idx(0, 2), idx(0, 4)]);
  });

  test("เปลี่ยนทิศระหว่าง chain ได้", () => {
    const game = gameWith(["oo......", ".o......", E, E, E, E, E, E]);
    expect(game.select(idx(0, 0)).ok).toBe(true);
    expect(game.state.selection!.requiredCaptures).toBe(2);
    expect(game.captureTo(idx(0, 2)).ok).toBe(true); // →
    expect(game.captureTo(idx(2, 0)).ok).toBe(true); // ↙ เปลี่ยนทิศ
    expect(game.state.scores).toEqual([2, 0]);
  });

  test("หมากที่ถูกกินถูกนำออกทันที กินซ้ำไม่ได้", () => {
    const game = gameWith(["oo.o....", E, E, E, E, E, E, E]);
    game.select(idx(0, 0));
    game.captureTo(idx(0, 2));
    expect(game.state.board[idx(0, 1)]).toBeNull();
    game.captureTo(idx(0, 4));
    expect(countPieces(game.state.board)).toBe(1);
  });

  test("ระหว่าง chain เปลี่ยนไปเลือกหมากตัวอื่นไม่ได้", () => {
    const game = gameWith(["oo.o....", E, E, E, E, E, "oo......", E]);
    game.select(idx(0, 0));
    game.captureTo(idx(0, 2));
    expect(game.select(idx(6, 0)).ok).toBe(false);
    expect(game.selectable()).toEqual([]);
  });
});

describe("กติกา Maximum Capture", () => {
  test("ก้าวแรกที่พาไปสู่ chain สั้นกว่าถูกปฏิเสธ", () => {
    // จาก (4,0): ขึ้นบนกินได้ 1 / ไปขวากินได้ 3 → ต้องไปขวาเท่านั้น
    const game = gameWith([E, E, E, "o.......", "oo.o.o..", E, E, E]);
    const from = idx(4, 0);
    const analysis = analyzeCaptures(game.state.board, from);
    expect(analysis.max).toBe(3);
    expect(analysis.steps.map((s) => s.to)).toEqual([idx(4, 2)]);

    expect(game.select(from).ok).toBe(true);
    const rejected = game.captureTo(idx(2, 0));
    expect(rejected.ok).toBe(false);
    // engine บอกแค่ว่าอะไรผิด พร้อมช่องที่ลงได้ ไม่ได้ผลิตข้อความให้คนอ่าน
    expect(rejected).toEqual({ ok: false, code: "must_take_maximum", params: { squares: ["c4"] } });
  });

  test("ต้องกินจนครบ chain สูงสุด เทิร์นจึงจบ", () => {
    const game = gameWith([E, E, E, "o.......", "oo.o.o..", E, E, E]);
    game.select(idx(4, 0));
    game.captureTo(idx(4, 2));
    expect(game.state.current).toBe(0);
    game.captureTo(idx(4, 4));
    expect(game.state.current).toBe(0);
    game.captureTo(idx(4, 6));
    expect(game.state.current).toBe(1);
    expect(game.state.scores).toEqual([3, 0]);
  });

  test("กติกาบังคับต่อหมากที่เลือก ไม่ใช่ทั้งกระดาน — เลือกหมากที่กินได้น้อยกว่าก็ได้", () => {
    const game = gameWith(["oo......", E, E, E, "oo.o.o..", E, E, E]);
    expect(analyzeCaptures(game.state.board, idx(4, 0)).max).toBe(3);
    expect(game.select(idx(0, 0)).ok).toBe(true); // กินได้แค่ 1 แต่เลือกได้
    expect(game.state.selection!.requiredCaptures).toBe(1);
  });
});

describe("Normal move", () => {
  test("หมากที่กินไม่ได้ ขยับได้ 1 ช่อง 8 ทิศ แล้วจบเทิร์นโดยไม่ได้คะแนน", () => {
    const game = gameWith([E, E, E, "...o....", E, E, E, E]);
    const from = idx(3, 3);
    expect(pieceOptions(game.state.board, from).kind).toBe("move");
    expect(moveDestinations(game.state.board, from).length).toBe(8);
    expect(game.select(from).ok).toBe(true);
    expect(game.moveTo(idx(2, 2)).ok).toBe(true);
    expect(game.state.scores).toEqual([0, 0]);
    expect(game.state.current).toBe(1);
    expect(game.state.history[0].kind).toBe("move");
  });

  test("หมากที่กินได้ จะเดินปกติไม่ได้", () => {
    const game = gameWith(["oo......", E, E, E, E, E, E, E]);
    game.select(idx(0, 0));
    expect(game.moveTo(idx(1, 0)).ok).toBe(false);
  });
});

describe("หมากเป็นของกลาง", () => {
  test("อีกฝ่ายหยิบหมากตัวเดิมที่เพิ่งถูกใช้ไปเล่นต่อได้", () => {
    const game = gameWith(["oo.o....", E, E, E, E, E, "oo......", E]);
    game.select(idx(6, 0));
    game.captureTo(idx(6, 2));
    const pieceId = game.state.history[0].pieceId;
    expect(game.state.current).toBe(1);
    expect(game.state.board[idx(6, 2)]).toBe(pieceId);
    expect(game.select(idx(6, 2)).ok).toBe(true);
  });

  test("เดินปกติแล้วเปิดทางให้คู่แข่งกินได้จริง (shared board risk)", () => {
    // A ขยับหมากไปต่อแถว แล้ว B หยิบหมากตัวไหนก็ได้มากิน
    const game = gameWith([E, E, E, "..o.....", "....o...", E, E, E]);
    expect(analyzeCaptures(game.state.board, idx(3, 2)).max).toBe(0);
    expect(analyzeCaptures(game.state.board, idx(4, 4)).max).toBe(0);
    game.select(idx(3, 2));
    game.moveTo(idx(3, 3)); // ขยับมาชิดหมากอีกตัวในแนวทแยง
    expect(game.state.current).toBe(1);
    expect(analyzeCaptures(game.state.board, idx(3, 3)).max).toBe(1);
    expect(game.select(idx(3, 3)).ok).toBe(true);
    expect(game.captureTo(idx(5, 5)).ok).toBe(true);
    expect(game.state.scores).toEqual([0, 1]); // คะแนนตกเป็นของ B
  });
});

describe("จบเกม", () => {
  test("จบเมื่อไม่มีการกินติดต่อกันครบตามลิมิต", () => {
    const state = createGameState(2, 2);
    state.board = boardFromAscii([E, E, E, "...o....", E, E, E, E]);
    const game = new Game(state);
    game.select(idx(3, 3));
    game.moveTo(idx(2, 2));
    expect(game.state.status).toBe("active");
    game.select(idx(2, 2));
    game.moveTo(idx(1, 1));
    expect(game.state.status).toBe("ended");
    expect(game.state.result!.reason).toBe("exhaustion");
  });

  test("การกินรีเซ็ตตัวนับเทิร์นที่ไม่มีการกิน", () => {
    const state = createGameState(2, 3);
    state.board = boardFromAscii(["oo......", E, E, E, E, E, E, E]);
    const game = new Game(state);
    game.select(idx(0, 0));
    game.captureTo(idx(0, 2));
    expect(game.state.noCaptureStreak).toBe(0);
    game.select(idx(0, 2));
    game.moveTo(idx(1, 2));
    expect(game.state.noCaptureStreak).toBe(1);
  });

  test("โหวตจบเกมแล้วตัดสินด้วยคะแนน", () => {
    const game = new Game();
    game.state.scores = [27, 23];
    expect(game.endGame("agreement").ok).toBe(true);
    expect(game.state.result).toEqual({ reason: "agreement", scores: [27, 23], winners: [0] });
  });

  test("คะแนนเท่ากันคือเสมอ (ผู้ชนะร่วมกันหลายคน)", () => {
    const game = new Game();
    game.state.scores = [10, 10];
    game.endGame("agreement");
    expect(game.state.result!.winners).toEqual([0, 1]);
  });

  test("ยอมแพ้ทำให้อีกฝ่ายชนะแม้คะแนนน้อยกว่า", () => {
    const game = new Game();
    game.state.scores = [30, 5];
    expect(game.retire(0).ok).toBe(true);
    expect(game.isActive).toBe(false);
    expect(game.state.result!.reason).toBe("resign");
    expect(game.state.result!.winners).toEqual([1]);
  });
});

describe("โหมดกติกา — ความผิดพลาดแบบกระดานจริง", () => {
  /** ● ○ . ○ . — หมากที่ a8 กินได้ 2 ตัวถ้าไล่จนสุด */
  function chainGame(mode: "assisted" | "standard" | "table"): Game {
    const state = createGameState(2, DEFAULT_NO_CAPTURE_LIMIT, RULE_PRESETS[mode]);
    state.board = boardFromAscii(["oo.o....", E, E, E, E, E, E, E]);
    return new Game(state);
  }

  test("โหมดช่วยคำนวณยังบังคับทุกอย่างตามสเปกเดิม", () => {
    const game = chainGame("assisted");
    game.select(idx(0, 0));
    expect(game.state.selection!.requiredCaptures).toBe(2);
    game.captureTo(idx(0, 2));
    expect(game.canEndTurn()).toBe(false);
    expect(game.endTurn().ok).toBe(false); // หยุดกลาง chain ไม่ได้
    game.captureTo(idx(0, 4));
    expect(game.state.scores).toEqual([2, 0]);
  });

  test("โหมดหละหลวม: กินต่อไม่ครบแล้วจบเทิร์นเองได้ คะแนนที่เหลือทิ้งไว้ให้คู่แข่ง", () => {
    const game = chainGame("standard");
    game.select(idx(0, 0));
    // ไม่บังคับ จึงไม่ตั้ง requiredCaptures แต่ยังรู้ว่ากินได้เต็มที่เท่าไร
    expect(game.state.selection!.requiredCaptures).toBe(0);
    expect(game.state.selection!.availableCaptures).toBe(2);

    game.captureTo(idx(0, 2));
    expect(game.state.current).toBe(0); // ยังไม่จบเทิร์นอัตโนมัติ
    expect(game.canEndTurn()).toBe(true);
    expect(game.endTurn().ok).toBe(true);

    expect(game.state.scores).toEqual([1, 0]);
    expect(game.state.current).toBe(1);
    expect(game.state.history[0].missedCaptures).toBe(1);

    // หมากที่ทิ้งไว้ตกเป็นของคู่แข่งได้ทันที เพราะกระดานเป็นของกลาง
    expect(game.select(idx(0, 2)).ok).toBe(true);
    expect(game.captureTo(idx(0, 4)).ok).toBe(true);
    expect(game.state.scores).toEqual([1, 1]);
  });

  test("โหมดหละหลวม: หาจุดกินไม่เจอ เดินหมากเปล่าแทนได้ และถูกบันทึกว่าพลาด", () => {
    const game = chainGame("standard");
    game.select(idx(0, 0));
    expect(game.state.selection!.kind).toBe("capture");
    expect(game.moveTo(idx(1, 0)).ok).toBe(true); // เดินปกติทั้งที่กินได้

    expect(game.state.scores).toEqual([0, 0]);
    const record = game.state.history[0];
    expect(record.kind).toBe("move");
    expect(record.availableCaptures).toBe(2);
    expect(record.missedCaptures).toBe(2);
  });

  test("โหมดหละหลวมยังตรวจความถูกกติกาของทุกก้าวอยู่", () => {
    const game = chainGame("standard");
    game.select(idx(0, 0));
    expect(game.captureTo(idx(0, 4)).ok).toBe(false); // ข้ามไปไกลเกินไป
    expect(game.moveTo(idx(3, 3)).ok).toBe(false); // ไม่ติดกัน
    expect(game.state.scores).toEqual([0, 0]);
  });

  test("โหมดหละหลวมเลือกทางกินที่สั้นกว่าได้", () => {
    // จาก (4,0): ขึ้นบนกิน 1 / ไปขวากิน 3
    const state = createGameState(2, DEFAULT_NO_CAPTURE_LIMIT, RULE_PRESETS.standard);
    state.board = boardFromAscii([E, E, E, "o.......", "oo.o.o..", E, E, E]);
    const game = new Game(state);
    game.select(idx(4, 0));
    expect(game.captureTo(idx(2, 0)).ok).toBe(true); // ทางที่กินได้แค่ 1
    expect(game.state.scores).toEqual([1, 0]);
    expect(game.state.history[0].missedCaptures).toBe(2);
  });

  test("จับแล้วต้องเดิน — ยกเลิกการเลือกไม่ได้ในโหมดกระดานจริง", () => {
    const table = chainGame("table");
    expect(table.select(idx(0, 0)).ok).toBe(true);
    expect(table.clearSelection().ok).toBe(false);
    expect(table.state.selection).not.toBeNull();

    const assisted = chainGame("assisted");
    assisted.select(idx(0, 0));
    expect(assisted.clearSelection().ok).toBe(true);
    expect(assisted.state.selection).toBeNull();
  });

  test("playTo ตีความเองว่ากินหรือเดิน โดย client ไม่ต้องรู้ล่วงหน้า", () => {
    const game = chainGame("standard");
    game.select(idx(0, 0));
    expect(game.playTo(idx(0, 2)).ok).toBe(true); // ช่องนี้เป็นการกิน
    expect(game.state.selection!.capturesSoFar).toBe(1);

    // คะแนนเข้าเมื่อจบเทิร์นเท่านั้น เพราะยังกินต่อได้และผู้เล่นเลือกจะหยุด
    expect(game.state.scores).toEqual([0, 0]);
    game.endTurn();
    expect(game.state.scores).toEqual([1, 0]);
    // หลังกิน เหลือหมากที่ (0,2) กับ (0,3) — ฝ่ายที่สองหยิบ (0,3) มาเดินเปล่า
    expect(game.select(idx(0, 3)).ok).toBe(true);
    expect(game.playTo(idx(1, 4)).ok).toBe(true); // ช่องนี้เป็นการเดิน
    expect(game.state.scores).toEqual([1, 0]);
  });

  test("จบเทิร์นโดยยังไม่ได้ลงมืออะไรไม่ได้", () => {
    const game = chainGame("standard");
    expect(game.endTurn().ok).toBe(false);
    game.select(idx(0, 0));
    expect(game.endTurn().ok).toBe(false);
  });

  test("สถิติสรุปโอกาสที่พลาดไปทั้งเกม", () => {
    const game = chainGame("standard");
    game.select(idx(0, 0));
    game.moveTo(idx(1, 0)); // พลาด 2
    const stats = game.stats();
    expect(stats.players[0].missedCaptures).toBe(2);
    expect(stats.players[0].missedTurns).toBe(1);
    expect(stats.players[0].worstMiss).toEqual({ turn: 1, missed: 2 });
    expect(stats.players[1].missedCaptures).toBe(0);
  });

  test("บันทึกไว้ด้วยว่าตานั้นทั้งกระดานกินได้สูงสุดเท่าไร", () => {
    const state = createGameState(2, DEFAULT_NO_CAPTURE_LIMIT, RULE_PRESETS.standard);
    state.board = boardFromAscii(["oo......", E, E, E, "oo.o.o..", E, E, E]);
    const game = new Game(state);
    game.select(idx(0, 0)); // หยิบตัวที่กินได้แค่ 1 ทั้งที่กระดานมีทาง 3
    game.captureTo(idx(0, 2));
    expect(game.state.history[0].bestAvailable).toBe(3);
    expect(game.state.history[0].captures).toBe(1);
  });
});

describe("เกม 3–4 ผู้เล่น", () => {
  test("เทิร์นวนตามลำดับที่นั่งครบทุกคน", () => {
    const game = new Game(createGameState(4));
    expect(game.state.scores).toEqual([0, 0, 0, 0]);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(game.state.current);
      game.playAutoTurn();
    }
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  test("คนถอนตัวถูกข้ามในลำดับเทิร์น แต่คนที่เหลือเล่นต่อ", () => {
    const game = new Game(createGameState(3));
    expect(game.state.current).toBe(0);
    game.playAutoTurn();
    expect(game.state.current).toBe(1);

    expect(game.retire(1).ok).toBe(true);
    expect(game.isActive).toBe(true);
    expect(game.activePlayers()).toEqual([0, 2]);
    expect(game.state.current).toBe(2); // ข้ามคนที่ถอนตัวไปแล้ว

    game.playAutoTurn();
    expect(game.state.current).toBe(0);
  });

  test("เกมจบเมื่อเหลือผู้เล่นคนเดียว และคนถอนตัวชนะไม่ได้แม้คะแนนนำ", () => {
    const game = new Game(createGameState(3));
    game.state.scores = [50, 1, 2];
    game.retire(0);
    expect(game.isActive).toBe(true);
    game.retire(1);
    expect(game.isActive).toBe(false);
    expect(game.state.result!.winners).toEqual([2]);
  });

  test("จำนวนผู้เล่นถูกบีบให้อยู่ในช่วง 2–4", () => {
    expect(createGameState(1).playerCount).toBe(2);
    expect(createGameState(9).playerCount).toBe(4);
    expect(createGameState(3).playerCount).toBe(3);
  });

  test("สถิติแยกรายคนครบทุกที่นั่ง", () => {
    const game = new Game(createGameState(4));
    for (let i = 0; i < 12; i++) game.playAutoTurn();
    const stats = game.stats();
    expect(stats.players.length).toBe(4);
    expect(stats.players.reduce((sum, player) => sum + player.turns, 0)).toBe(stats.turns);
  });
});

describe("ประสิทธิภาพและสถิติ", () => {
  test("วิเคราะห์ทุกหมากบนกระดานเริ่มต้นได้เร็ว", () => {
    const board = initialBoard();
    const started = performance.now();
    for (let i = 0; i < 64; i++) if (board[i] !== null) analyzeCaptures(board, i);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("เล่นอัตโนมัติจนจบเกมได้ และคะแนนรวมเท่ากับหมากที่หายไป", () => {
    const game = new Game();
    let guard = 0;
    while (game.isActive && guard++ < 2000) game.playAutoTurn();
    expect(game.isActive).toBe(false);
    const total = game.state.scores[0] + game.state.scores[1];
    expect(total).toBe(60 - countPieces(game.state.board));
    const stats = game.stats();
    expect(stats.turns).toBe(game.state.history.length);
    expect(stats.players[0].captures + stats.players[1].captures).toBe(total);
    expect(stats.players[0].bestChain).toBeGreaterThan(0);
  });
});
