/**
 * ระบบ rating แบบ Elo — pure function ทั้งหมด ไม่รู้จัก database
 *
 * Elo ดั้งเดิมออกแบบมาสำหรับเกม 2 คน เกมนี้เล่นได้ถึง 4 คน จึงใช้วิธีมาตรฐาน
 * ของการขยาย Elo ไปหลายคน คือแตกเป็นการเจอกันแบบคู่ทุกคู่ แล้วเฉลี่ยด้วย (n-1)
 * ผลลัพธ์คือคนที่ชนะคนเรตติ้งสูงได้แต้มเยอะกว่าชนะคนเรตติ้งต่ำ เหมือน Elo ปกติ
 */

export const DEFAULT_RATING = 1200;

export interface RatingInput {
  rating: number;
  /** คะแนนที่ทำได้ในแมตช์นั้น */
  score: number;
  /** ถอนตัวกลางคัน — ถือว่าแพ้ทุกคู่ ไม่ว่าคะแนนจะนำอยู่หรือไม่ */
  retired: boolean;
  gamesPlayed: number;
}

export interface RatingChange {
  before: number;
  after: number;
  delta: number;
  outcome: "win" | "loss" | "draw";
}

/**
 * K-factor — ยิ่งเล่นน้อยยิ่งขยับเร็ว เพื่อให้เรตติ้งเข้าที่ไว
 * และผู้เล่นเรตติ้งสูงขยับช้าลงเพื่อความเสถียรของหัวตาราง
 */
export function kFactor(rating: number, gamesPlayed: number): number {
  if (gamesPlayed < 30) return 32;
  if (rating >= 2000) return 16;
  return 24;
}

export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/** ผลการเจอกันของคู่หนึ่ง: 1 ชนะ, 0.5 เสมอ, 0 แพ้ */
function pairResult(a: RatingInput, b: RatingInput): number {
  // คนถอนตัวถือว่าแพ้เสมอ ยกเว้นเจอกันเองระหว่างคนที่ถอนตัวทั้งคู่
  if (a.retired && !b.retired) return 0;
  if (!a.retired && b.retired) return 1;
  if (a.score > b.score) return 1;
  if (a.score < b.score) return 0;
  return 0.5;
}

export function computeRatingChanges(players: RatingInput[]): RatingChange[] {
  if (players.length < 2) {
    return players.map((player) => ({
      before: player.rating,
      after: player.rating,
      delta: 0,
      outcome: "draw" as const,
    }));
  }

  return players.map((player, index) => {
    let actual = 0;
    let expected = 0;
    let wins = 0;
    let losses = 0;

    for (let other = 0; other < players.length; other++) {
      if (other === index) continue;
      const result = pairResult(player, players[other]);
      actual += result;
      expected += expectedScore(player.rating, players[other].rating);
      if (result === 1) wins++;
      else if (result === 0) losses++;
    }

    const divisor = players.length - 1;
    const delta = Math.round((kFactor(player.rating, player.gamesPlayed) * (actual - expected)) / divisor);
    const outcome = wins > losses ? "win" : losses > wins ? "loss" : "draw";

    return { before: player.rating, after: player.rating + delta, delta, outcome };
  });
}
