import { describe, expect, test } from "bun:test";
import { DEFAULT_RATING, computeRatingChanges, expectedScore, kFactor } from "./rating.js";

const player = (rating: number, score: number, retired = false, gamesPlayed = 0) => ({
  rating,
  score,
  retired,
  gamesPlayed,
});

describe("Elo", () => {
  test("เรตติ้งเท่ากันมีโอกาสชนะครึ่งต่อครึ่ง", () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
    expect(expectedScore(1600, 1200)).toBeGreaterThan(0.9);
    expect(expectedScore(1200, 1600)).toBeLessThan(0.1);
  });

  test("K-factor ลดลงเมื่อเล่นเยอะขึ้นและเรตติ้งสูงขึ้น", () => {
    expect(kFactor(DEFAULT_RATING, 0)).toBe(32);
    expect(kFactor(DEFAULT_RATING, 50)).toBe(24);
    expect(kFactor(2100, 50)).toBe(16);
  });

  test("ชนะแล้วได้แต้ม แพ้แล้วเสียแต้ม และผลรวมเป็นศูนย์", () => {
    const [winner, loser] = computeRatingChanges([player(1200, 30), player(1200, 20)]);
    expect(winner.delta).toBe(16);
    expect(loser.delta).toBe(-16);
    expect(winner.outcome).toBe("win");
    expect(loser.outcome).toBe("loss");
    expect(winner.delta + loser.delta).toBe(0);
  });

  test("ชนะคนเรตติ้งสูงกว่าได้แต้มเยอะกว่าชนะคนเรตติ้งต่ำกว่า", () => {
    const [underdog] = computeRatingChanges([player(1200, 30), player(1800, 20)]);
    const [favourite] = computeRatingChanges([player(1800, 30), player(1200, 20)]);
    expect(underdog.delta).toBeGreaterThan(favourite.delta);
    expect(favourite.delta).toBeLessThan(5);
  });

  test("คะแนนเท่ากันคือเสมอ ไม่มีใครขยับถ้าเรตติ้งเท่ากัน", () => {
    const changes = computeRatingChanges([player(1200, 25), player(1200, 25)]);
    expect(changes.map((c) => c.delta)).toEqual([0, 0]);
    expect(changes.map((c) => c.outcome)).toEqual(["draw", "draw"]);
  });

  test("เกม 4 คน: ที่หนึ่งได้แต้ม ที่โหล่เสียแต้ม", () => {
    const changes = computeRatingChanges([
      player(1200, 30),
      player(1200, 20),
      player(1200, 15),
      player(1200, 5),
    ]);
    expect(changes[0].delta).toBeGreaterThan(0);
    expect(changes[3].delta).toBeLessThan(0);
    expect(changes[0].delta).toBeGreaterThan(changes[1].delta);
    expect(changes[1].delta).toBeGreaterThan(changes[2].delta);
    // ระบบผลรวมเป็นศูนย์ (คลาดได้เล็กน้อยจากการปัดเศษ)
    expect(Math.abs(changes.reduce((sum, c) => sum + c.delta, 0))).toBeLessThanOrEqual(2);
  });

  test("ถอนตัวกลางคันถือว่าแพ้ ถึงคะแนนจะนำอยู่", () => {
    const changes = computeRatingChanges([player(1200, 50, true), player(1200, 1)]);
    expect(changes[0].delta).toBeLessThan(0);
    expect(changes[0].outcome).toBe("loss");
    expect(changes[1].outcome).toBe("win");
  });

  test("ผู้เล่นคนเดียวไม่มีอะไรให้คิด", () => {
    expect(computeRatingChanges([player(1200, 10)])[0].delta).toBe(0);
  });
});
