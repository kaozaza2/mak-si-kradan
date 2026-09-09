/**
 * ทดสอบชั้นเก็บข้อมูลกับ SQLite จริง (ไม่ได้ mock Prisma)
 * ใช้สำเนาไฟล์ฐานข้อมูลที่ push schema ไว้แล้ว เพื่อไม่ไปยุ่งกับ dev.db
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, type Connection } from "./hub.js";
import { signToken } from "./auth.js";
import { NullStore, PrismaStore, type MatchStore } from "./store.js";
import type { ServerMessage } from "./protocol.js";
import { createGameState } from "../engine/index.js";

const TEMPLATE = new URL("../../prisma/dev.db", import.meta.url).pathname;

let directory: string;
let store: PrismaStore;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "msk-store-"));
  const file = join(directory, "test.db");
  await copyFile(TEMPLATE, file);
  const created = await PrismaStore.fromEnv(`file:${file}`);
  if (!created) throw new Error("สร้าง PrismaStore ไม่สำเร็จ");
  store = created;
});

afterAll(async () => {
  await store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("PrismaStore", () => {
  test("บันทึกผู้เล่น แมตช์ การเดิน และผลจบเกม แล้วอ่านกลับได้ครบ", async () => {
    await store.saveSession({ id: "guest_aaa111", name: "อาทิตย์", kind: "guest" });
    await store.saveSession({ id: "guest_bbb222", name: "บุญมี", kind: "guest" });

    await store.createMatch({
      id: "match_test_1",
      source: "room",
      playerCount: 2,
      turnSeconds: 45,
      players: [
        { seat: 0, playerId: "guest_aaa111", name: "อาทิตย์", isBot: false, botLevel: null },
        { seat: 1, playerId: "guest_bbb222", name: "บุญมี", isBot: false, botLevel: null },
      ],
    });

    await store.recordActions("match_test_1", [
      { turn: 1, player: 0, pieceId: 17, kind: "capture", path: [10, 28], capturedSquares: [19], captures: 1, scoreDelta: 1, availableCaptures: 2, missedCaptures: 1, bestAvailable: 3 },
      { turn: 2, player: 1, pieceId: 42, kind: "move", path: [50, 43], capturedSquares: [], captures: 0, scoreDelta: 0, availableCaptures: 0, missedCaptures: 0, bestAvailable: 0 },
    ]);

    await store.finishMatch("match_test_1", {
      reason: "agreement",
      scores: [27, 23],
      winners: [0],
      retired: [],
      turns: 2,
      state: createGameState(),
    });

    const history = await store.recentMatches("guest_aaa111");
    expect(history.length).toBe(1);
    const match = history[0];
    expect(match.id).toBe("match_test_1");
    expect(match.source).toBe("room");
    expect(match.reason).toBe("agreement");
    expect(match.turns).toBe(2);
    expect(match.endedAt).not.toBeNull();
    expect(match.players.map((p) => p.score)).toEqual([27, 23]);
    expect(match.players[0].winner).toBe(true);
    expect(match.players[1].winner).toBe(false);
  });

  test("บอทถูกบันทึกเป็นที่นั่งของ match แต่ไม่กลายเป็นผู้เล่นถาวร", async () => {
    await store.saveSession({ id: "guest_ccc333", name: "เก้า", kind: "guest" });
    await store.createMatch({
      id: "match_test_ai",
      source: "ai",
      playerCount: 2,
      turnSeconds: 0,
      players: [
        { seat: 0, playerId: "guest_ccc333", name: "เก้า", isBot: false, botLevel: null },
        { seat: 1, playerId: "bot_xyz", name: "AI (ยาก)", isBot: true, botLevel: "hard" },
      ],
    });

    const history = await store.recentMatches("guest_ccc333");
    const seats = history[0].players;
    expect(seats[1].isBot).toBe(true);
    expect(seats[1].name).toContain("ยาก");
    // ไม่มีประวัติของบอทเพราะไม่ได้ผูกกับตาราง Player
    expect(await store.recentMatches("bot_xyz")).toEqual([]);
  });

  test("เปลี่ยนชื่อแล้วชื่อในแมตช์เก่ายังเป็นชื่อ ณ ตอนนั้น", async () => {
    await store.saveSession({ id: "guest_aaa111", name: "อาทิตย์คนใหม่", kind: "guest" });
    const history = await store.recentMatches("guest_aaa111");
    expect(history[0].players[0].name).toBe("อาทิตย์");
  });
});

describe("บัญชีผู้ใช้และ rating", () => {
  test("สมัคร ล็อกอิน และอ่านโปรไฟล์กลับมาได้", async () => {
    const created = await store.registerUser("kao", "password1234", "เก้า");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user.rating).toBe(1200);
    expect(created.user.username).toBe("kao");

    const login = await store.loginUser("kao", "password1234");
    expect(login.ok).toBe(true);
    if (login.ok) expect(login.user.id).toBe(created.user.id);

    const profile = await store.getUser(created.user.id);
    expect(profile?.name).toBe("เก้า");
  });

  test("ชื่อผู้ใช้ซ้ำไม่ได้", async () => {
    await store.registerUser("dup", "password1234", "ซ้ำ");
    const again = await store.registerUser("dup", "password5678", "ซ้ำสอง");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("username_taken");
  });

  test("รหัสผ่านผิดกับไม่มีบัญชีให้ข้อความเดียวกัน จะได้ไม่บอกใบ้ว่ามีชื่อนั้นอยู่", async () => {
    await store.registerUser("secret", "password1234", "ลับ");
    const wrongPassword = await store.loginUser("secret", "wrongwrongwrong");
    const noSuchUser = await store.loginUser("nobodyhere", "wrongwrongwrong");
    expect(wrongPassword.ok).toBe(false);
    expect(noSuchUser.ok).toBe(false);
    if (!wrongPassword.ok && !noSuchUser.ok) expect(wrongPassword.code).toBe(noSuchUser.code);
  });

  test("ไม่เก็บรหัสผ่านดิบ", async () => {
    const created = await store.registerUser("hashed", "password1234", "แฮช");
    expect(created.ok).toBe(true);
    // อ่านผ่าน getUser ต้องไม่มีฟิลด์รหัสผ่านหลุดออกมา
    const profile = created.ok ? await store.getUser(created.user.id) : null;
    expect(JSON.stringify(profile)).not.toContain("password1234");
  });

  test("แมตช์ที่ทุกที่นั่งเป็นบัญชีจริงถูกนับ rating", async () => {
    const a = await store.registerUser("rated_a", "password1234", "เอ");
    const b = await store.registerUser("rated_b", "password1234", "บี");
    if (!a.ok || !b.ok) throw new Error("สมัครไม่สำเร็จ");

    await store.createMatch({
      id: "match_rated",
      source: "quick",
      playerCount: 2,
      turnSeconds: 45,
      players: [
        { seat: 0, playerId: a.user.id, name: "เอ", isBot: false, botLevel: null },
        { seat: 1, playerId: b.user.id, name: "บี", isBot: false, botLevel: null },
      ],
    });
    await store.finishMatch("match_rated", {
      reason: "agreement",
      scores: [30, 20],
      winners: [0],
      retired: [],
      turns: 10,
      state: createGameState(),
    });

    const winner = await store.getUser(a.user.id);
    const loser = await store.getUser(b.user.id);
    expect(winner!.rating).toBe(1216);
    expect(loser!.rating).toBe(1184);
    expect(winner!.wins).toBe(1);
    expect(loser!.losses).toBe(1);
    expect(winner!.gamesPlayed).toBe(1);
  });

  test("แมตช์ที่มีบอทไม่นับ rating", async () => {
    const human = await store.registerUser("vs_bot", "password1234", "คน");
    if (!human.ok) throw new Error("สมัครไม่สำเร็จ");
    const before = human.user.rating;

    await store.createMatch({
      id: "match_unrated_bot",
      source: "ai",
      playerCount: 2,
      turnSeconds: 0,
      players: [
        { seat: 0, playerId: human.user.id, name: "คน", isBot: false, botLevel: null },
        { seat: 1, playerId: "bot_1", name: "AI (ยาก)", isBot: true, botLevel: "hard" },
      ],
    });
    await store.finishMatch("match_unrated_bot", {
      reason: "agreement",
      scores: [40, 10],
      winners: [0],
      retired: [],
      turns: 8,
      state: createGameState(),
    });

    const after = await store.getUser(human.user.id);
    expect(after!.rating).toBe(before);
    expect(after!.gamesPlayed).toBe(0);
  });

  test("แมตช์ที่มี guest ไม่นับ rating", async () => {
    const user = await store.registerUser("vs_guest", "password1234", "สมาชิก");
    if (!user.ok) throw new Error("สมัครไม่สำเร็จ");
    await store.saveSession({ id: "guest_zzz999", name: "แขก", kind: "guest" });

    await store.createMatch({
      id: "match_unrated_guest",
      source: "room",
      playerCount: 2,
      turnSeconds: 0,
      players: [
        { seat: 0, playerId: user.user.id, name: "สมาชิก", isBot: false, botLevel: null },
        { seat: 1, playerId: "guest_zzz999", name: "แขก", isBot: false, botLevel: null },
      ],
    });
    await store.finishMatch("match_unrated_guest", {
      reason: "agreement",
      scores: [5, 40],
      winners: [1],
      retired: [],
      turns: 6,
      state: createGameState(),
    });

    expect((await store.getUser(user.user.id))!.gamesPlayed).toBe(0);
  });

  test("อันดับเรียงตาม rating และนับเฉพาะคนที่เคยเล่น", async () => {
    const board = await store.leaderboard(10);
    expect(board.length).toBeGreaterThan(0);
    expect(board[0].rank).toBe(1);
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1].rating).toBeGreaterThanOrEqual(board[i].rating);
    }
    // คนที่ยังไม่เคยเล่นแมตช์ที่นับคะแนนจะไม่อยู่ในตาราง
    expect(board.some((row) => row.username === "vs_bot")).toBe(false);
  });
});

describe("สมัครด้วยอีเมลและ OTP", () => {
  test("สมัครแล้วยังไม่ยืนยัน ต้องกรอก OTP ก่อนถึงจะ verified", async () => {
    const created = await store.registerWithEmail("Player@Example.com", "password1234", "ผู้เล่น");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user.email).toBe("player@example.com"); // เก็บเป็นตัวพิมพ์เล็กเสมอ
    expect(created.user.verified).toBe(false);

    const issued = await store.issueOtp("player@example.com");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toMatch(/^\d{6}$/);

    const verified = await store.verifyOtp("PLAYER@example.com", issued.code);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.user.verified).toBe(true);
  });

  test("ล็อกอินด้วยอีเมลหรือชื่อผู้ใช้ก็ได้", async () => {
    await store.registerWithEmail("both@example.com", "password1234", "ทั้งสอง");
    const byEmail = await store.loginUser("Both@Example.com", "password1234");
    expect(byEmail.ok).toBe(true);
  });

  test("รหัสผิดนับครั้ง และครบโควตาแล้วรหัสถูกทิ้ง", async () => {
    await store.registerWithEmail("bruteforce@example.com", "password1234", "เดา");
    const issued = await store.issueOtp("bruteforce@example.com");
    if (!issued.ok) throw new Error("ออกรหัสไม่สำเร็จ");

    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await store.verifyOtp("bruteforce@example.com", "000000");
      expect(wrong.ok).toBe(false);
    }
    // ครบ 5 ครั้งแล้ว ถึงกรอกถูกก็ใช้ไม่ได้ ต้องขอใหม่
    const correct = await store.verifyOtp("bruteforce@example.com", issued.code);
    expect(correct.ok).toBe(false);
    if (!correct.ok) expect(correct.code).toBe("otp_too_many_attempts");
  });

  test("รหัสใช้ได้ครั้งเดียว", async () => {
    await store.registerWithEmail("once@example.com", "password1234", "ครั้งเดียว");
    const issued = await store.issueOtp("once@example.com");
    if (!issued.ok) throw new Error("ออกรหัสไม่สำเร็จ");

    expect((await store.verifyOtp("once@example.com", issued.code)).ok).toBe(true);
    expect((await store.verifyOtp("once@example.com", issued.code)).ok).toBe(false);
  });

  test("ขอรหัสใหม่แล้วรหัสเก่าใช้ไม่ได้", async () => {
    await store.registerWithEmail("rotate@example.com", "password1234", "หมุน");
    const first = await store.issueOtp("rotate@example.com");
    const second = await store.issueOtp("rotate@example.com");
    if (!first.ok || !second.ok) throw new Error("ออกรหัสไม่สำเร็จ");

    expect((await store.verifyOtp("rotate@example.com", first.code)).ok).toBe(false);
    expect((await store.verifyOtp("rotate@example.com", second.code)).ok).toBe(true);
  });

  test("อีเมลซ้ำสมัครไม่ได้ และยืนยันแล้วขอรหัสอีกไม่ได้", async () => {
    await store.registerWithEmail("taken@example.com", "password1234", "จองแล้ว");
    const again = await store.registerWithEmail("Taken@example.com", "password5678", "ซ้ำ");
    expect(again.ok).toBe(false);

    const issued = await store.issueOtp("taken@example.com");
    if (!issued.ok) throw new Error("ออกรหัสไม่สำเร็จ");
    await store.verifyOtp("taken@example.com", issued.code);
    expect((await store.issueOtp("taken@example.com")).ok).toBe(false);
  });

  test("บัญชีที่ยังไม่ยืนยันอีเมลไม่นับ rating", async () => {
    const a = await store.registerWithEmail("unv_a@example.com", "password1234", "ยังไม่ยืนยัน");
    const b = await store.registerWithEmail("unv_b@example.com", "password1234", "ยังไม่ยืนยันสอง");
    if (!a.ok || !b.ok) throw new Error("สมัครไม่สำเร็จ");

    await store.createMatch({
      id: "match_unverified",
      source: "quick",
      playerCount: 2,
      turnSeconds: 0,
      players: [
        { seat: 0, playerId: a.user.id, name: "A", isBot: false, botLevel: null },
        { seat: 1, playerId: b.user.id, name: "B", isBot: false, botLevel: null },
      ],
    });
    await store.finishMatch("match_unverified", {
      reason: "agreement",
      scores: [30, 10],
      winners: [0],
      retired: [],
      turns: 5,
      state: createGameState(),
    });

    expect((await store.getUser(a.user.id))!.gamesPlayed).toBe(0);
  });
});

describe("ล็อกอินด้วย Google", () => {
  const identity = (overrides: Record<string, unknown> = {}) => ({
    sub: "google-sub-1",
    email: "gplayer@example.com",
    emailVerified: true,
    name: "ผู้เล่นกูเกิล",
    ...overrides,
  });

  test("ครั้งแรกสร้างบัญชีใหม่ ครั้งต่อไปได้บัญชีเดิม", async () => {
    const first = await store.loginWithGoogle(identity());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.user.verified).toBe(true);
    expect(first.user.google).toBe(true);

    const second = await store.loginWithGoogle(identity());
    if (second.ok) expect(second.user.id).toBe(first.user.id);
  });

  test("อีเมลตรงกับบัญชีเดิมที่ยืนยันแล้วจะผูกเข้าด้วยกัน ไม่สร้างซ้ำ", async () => {
    const registered = await store.registerWithEmail("link@example.com", "password1234", "ผูกบัญชี");
    if (!registered.ok) throw new Error("สมัครไม่สำเร็จ");
    const issued = await store.issueOtp("link@example.com");
    if (!issued.ok) throw new Error("ออกรหัสไม่สำเร็จ");
    await store.verifyOtp("link@example.com", issued.code);

    const viaGoogle = await store.loginWithGoogle(identity({ sub: "google-sub-link", email: "link@example.com" }));
    expect(viaGoogle.ok).toBe(true);
    if (viaGoogle.ok) {
      expect(viaGoogle.user.id).toBe(registered.user.id);
      expect(viaGoogle.user.google).toBe(true);
    }
  });

  test("Google ที่ยังไม่ยืนยันอีเมลจะไม่ถูกผูกกับบัญชีเดิม", async () => {
    const registered = await store.registerWithEmail("noclaim@example.com", "password1234", "ห้ามยึด");
    if (!registered.ok) throw new Error("สมัครไม่สำเร็จ");

    const attacker = await store.loginWithGoogle(
      identity({ sub: "google-sub-attacker", email: "noclaim@example.com", emailVerified: false }),
    );
    expect(attacker.ok).toBe(true);
    // ต้องเป็นคนละบัญชีกัน ไม่ใช่ยึดบัญชีเดิมไป
    if (attacker.ok) expect(attacker.user.id).not.toBe(registered.user.id);
  });
});

describe("ระบบเพื่อน", () => {
  async function makeUser(username: string): Promise<string> {
    const created = await store.registerUser(username, "password1234", username);
    if (!created.ok) throw new Error(`สมัคร ${username} ไม่สำเร็จ`);
    return created.user.id;
  }

  test("ขอเป็นเพื่อน ตอบรับ แล้วเห็นกันทั้งสองฝั่ง", async () => {
    const a = await makeUser("friend_a");
    const b = await makeUser("friend_b");

    const request = await store.requestFriend(a, "friend_b");
    expect(request).toMatchObject({ ok: true, status: "pending" });

    const beforeAccept = await store.listFriends(b);
    expect(beforeAccept.incoming.length).toBe(1);
    expect(beforeAccept.incoming[0].player.username).toBe("friend_a");
    expect((await store.listFriends(a)).outgoing.length).toBe(1);

    const accepted = await store.respondFriend(b, beforeAccept.incoming[0].requestId, true);
    expect(accepted).toMatchObject({ ok: true, status: "accepted" });

    expect((await store.listFriends(a)).friends.map((f) => f.username)).toEqual(["friend_b"]);
    expect((await store.listFriends(b)).friends.map((f) => f.username)).toEqual(["friend_a"]);
    expect(await store.areFriends(a, b)).toBe(true);
    expect(await store.friendIds(a)).toEqual([b]);
  });

  test("ขอสวนกันถือว่าตกลงทันที ไม่ต้องรออีกขั้น", async () => {
    const a = await makeUser("cross_a");
    const b = await makeUser("cross_b");

    await store.requestFriend(a, "cross_b");
    const reverse = await store.requestFriend(b, "cross_a");
    expect(reverse).toMatchObject({ ok: true, status: "accepted" });
    expect(await store.areFriends(a, b)).toBe(true);
  });

  test("ปฏิเสธแล้วคำขอหายไป ขอใหม่ได้", async () => {
    const a = await makeUser("decline_a");
    const b = await makeUser("decline_b");
    await store.requestFriend(a, "decline_b");

    const incoming = (await store.listFriends(b)).incoming;
    expect((await store.respondFriend(b, incoming[0].requestId, false)).ok).toBe(true);
    expect((await store.listFriends(b)).incoming.length).toBe(0);
    expect(await store.areFriends(a, b)).toBe(false);

    expect((await store.requestFriend(a, "decline_b")).ok).toBe(true);
  });

  test("ขอซ้ำ ขอตัวเอง และขอคนที่เป็นเพื่อนแล้วถูกปฏิเสธพร้อม code", async () => {
    const a = await makeUser("dup_a");
    await makeUser("dup_b");

    expect(await store.requestFriend(a, "dup_a")).toEqual({ ok: false, code: "friend_self" });
    expect(await store.requestFriend(a, "ไม่มีคนนี้")).toEqual({ ok: false, code: "player_not_found" });

    await store.requestFriend(a, "dup_b");
    expect(await store.requestFriend(a, "dup_b")).toEqual({ ok: false, code: "friend_request_pending" });
  });

  test("ตอบคำขอของคนอื่นไม่ได้", async () => {
    const a = await makeUser("guard_a");
    const b = await makeUser("guard_b");
    const c = await makeUser("guard_c");
    await store.requestFriend(a, "guard_b");
    const requestId = (await store.listFriends(b)).incoming[0].requestId;

    expect(await store.respondFriend(c, requestId, true)).toEqual({ ok: false, code: "friend_request_gone" });
    expect(await store.areFriends(a, b)).toBe(false);
  });

  test("ลบเพื่อนแล้วหายทั้งสองฝั่ง", async () => {
    const a = await makeUser("bye_a");
    const b = await makeUser("bye_b");
    await store.requestFriend(a, "bye_b");
    const requestId = (await store.listFriends(b)).incoming[0].requestId;
    await store.respondFriend(b, requestId, true);

    expect((await store.removeFriend(a, b)).ok).toBe(true);
    expect((await store.listFriends(b)).friends.length).toBe(0);
    expect(await store.areFriends(a, b)).toBe(false);
  });

  test("ค้นหาผู้เล่นได้ด้วยชื่อบางส่วน และไม่เจอตัวเอง", async () => {
    const me = await makeUser("searcher");
    await makeUser("findme_one");
    await makeUser("findme_two");

    const found = await store.searchPlayers("findme", me);
    expect(found.length).toBe(2);
    expect(found.every((player) => player.id !== me)).toBe(true);
    // สั้นเกินไปไม่ค้น กันการดึงรายชื่อทั้งระบบ
    expect(await store.searchPlayers("f", me)).toEqual([]);
  });
});

describe("Hub กับ store", () => {
  test("เล่นจนจบแล้วมีประวัติครบทุกเทิร์นในฐานข้อมูล", async () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 0, store });
    const conn = fakeConnection();
    hub.handleMessage(conn, { type: "hello", name: "นักเล่น" });
    const sessionId = lastOf(conn, "session")!.id;

    hub.handleMessage(conn, { type: "play_ai", level: "easy" });
    const you = lastOf(conn, "match_start")!.you;

    for (let i = 0; i < 40; i++) {
      const state = lastOf(conn, "state")!.state;
      if (state.status !== "active") break;
      if (state.current === you) playTurn(hub, conn);
      else await Bun.sleep(4);
    }
    hub.handleMessage(conn, { type: "resign" });
    await hub.flush();

    const matchId = lastOf(conn, "match_start")!.matchId;
    const history = await store.recentMatches(sessionId);
    const stored = history.find((match) => match.id === matchId)!;
    expect(stored).toBeDefined();
    expect(stored.source).toBe("ai");
    expect(stored.reason).toBe("resign");
    expect(stored.turns).toBeGreaterThan(0);
    expect(stored.players.length).toBe(2);
    expect(stored.players.some((player) => player.isBot)).toBe(true);
    hub.dispose();
  });
});

describe("เพื่อนและคำเชิญผ่าน Hub", () => {
  const SECRET = "hub-friend-tests-secret-value";

  async function signedUser(username: string): Promise<{ id: string; token: string; name: string }> {
    const created = await store.registerUser(username, "password1234", username);
    if (!created.ok) throw new Error("สมัครไม่สำเร็จ");
    return {
      id: created.user.id,
      name: created.user.name,
      token: signToken({ sub: created.user.id, name: created.user.name, kind: "user" }, SECRET),
    };
  }

  function newHub(): Hub {
    return new Hub({ defaultTurnSeconds: 0, authSecret: SECRET, store });
  }

  test("guest ใช้ระบบเพื่อนไม่ได้", async () => {
    const hub = newHub();
    const guest = fakeConnection();
    hub.handleMessage(guest, { type: "hello", name: "แขก" });
    hub.handleMessage(guest, { type: "list_friends" });
    await Bun.sleep(30);
    expect(lastOf(guest, "error")?.code).toBe("friends_need_account");
    hub.dispose();
  });

  test("ขอเป็นเพื่อนแล้วอีกฝ่ายเห็นคำขอทันที และรับแล้วเห็นกันทั้งคู่", async () => {
    const hub = newHub();
    const alice = await signedUser("hub_alice");
    const bob = await signedUser("hub_bob");

    const a = fakeConnection();
    const b = fakeConnection();
    hub.handleMessage(a, { type: "hello", token: alice.token });
    hub.handleMessage(b, { type: "hello", token: bob.token });
    await Bun.sleep(50);

    hub.handleMessage(a, { type: "friend_request", identifier: "hub_bob" });
    await Bun.sleep(80);

    // อีกฝ่ายได้รายชื่อใหม่เองโดยไม่ต้องกดรีเฟรช
    const incoming = lastOf(b, "friends")!.incoming;
    expect(incoming.length).toBe(1);
    expect(incoming[0].player.username).toBe("hub_alice");

    hub.handleMessage(b, { type: "friend_respond", requestId: incoming[0].requestId, accept: true });
    await Bun.sleep(80);

    expect(lastOf(a, "friends")!.friends.map((f) => f.username)).toEqual(["hub_bob"]);
    // ทั้งคู่ต่ออยู่ จึงต้องขึ้นว่าออนไลน์
    expect(lastOf(a, "friends")!.friends[0].online).toBe(true);
    hub.dispose();
  });

  test("เพื่อนที่ไม่ได้ต่ออยู่ขึ้นว่าออฟไลน์", async () => {
    const hub = newHub();
    const carol = await signedUser("hub_carol");
    const dave = await signedUser("hub_dave");
    await store.requestFriend(carol.id, "hub_dave");
    const requestId = (await store.listFriends(dave.id)).incoming[0].requestId;
    await store.respondFriend(dave.id, requestId, true);

    const c = fakeConnection();
    hub.handleMessage(c, { type: "hello", token: carol.token });
    hub.handleMessage(c, { type: "list_friends" });
    await Bun.sleep(60);

    const friends = lastOf(c, "friends")!.friends;
    expect(friends.length).toBe(1);
    expect(friends[0].online).toBe(false);
    hub.dispose();
  });

  test("ชวนเพื่อนเข้าห้อง แล้วเขากดเข้าร่วมด้วยรหัสห้อง", async () => {
    const hub = newHub();
    const host = await signedUser("hub_host");
    const mate = await signedUser("hub_mate");

    const h = fakeConnection();
    const m = fakeConnection();
    hub.handleMessage(h, { type: "hello", token: host.token });
    hub.handleMessage(m, { type: "hello", token: mate.token });
    await Bun.sleep(40);

    hub.handleMessage(h, { type: "create_room", capacity: 2 });
    hub.handleMessage(h, { type: "invite_to_room", targetId: mate.id });
    await Bun.sleep(50);

    const invite = lastOf(m, "room_invite")!;
    expect(invite.from.name).toBe("hub_host");
    expect(invite.code).toBe(lastOf(h, "room")!.room.code);
    expect(invite.capacity).toBe(2);
    expect(lastOf(h, "info")?.code).toBe("invite_sent");

    // ตอบรับคือการเข้าห้องด้วยรหัสธรรมดา ไม่ต้องมีสถานะคำเชิญฝั่ง server
    hub.handleMessage(m, { type: "join_room", code: invite.code });
    expect(lastOf(m, "room")!.room.players.length).toBe(2);
    hub.dispose();
  });

  test("ยังไม่ได้อยู่ในห้องก็ชวนใครไม่ได้ และชวนคนที่ติดอยู่แล้วไม่ได้", async () => {
    const hub = newHub();
    const one = await signedUser("hub_one");
    const two = await signedUser("hub_two");

    const a = fakeConnection();
    const b = fakeConnection();
    hub.handleMessage(a, { type: "hello", token: one.token });
    hub.handleMessage(b, { type: "hello", token: two.token });
    await Bun.sleep(40);

    hub.handleMessage(a, { type: "invite_to_room", targetId: two.id });
    await Bun.sleep(20);
    expect(lastOf(a, "error")?.code).toBe("invite_needs_room");

    hub.handleMessage(b, { type: "create_room", capacity: 2 });
    hub.handleMessage(a, { type: "create_room", capacity: 2 });
    hub.handleMessage(a, { type: "invite_to_room", targetId: two.id });
    await Bun.sleep(30);
    expect(lastOf(a, "error")?.code).toBe("invite_target_busy");
    hub.dispose();
  });
});

describe("NullStore", () => {
  test("เกมทำงานได้โดยไม่ต้องมีฐานข้อมูล", async () => {
    const nullStore: MatchStore = new NullStore();
    const hub = new Hub({ defaultTurnSeconds: 0, store: nullStore });
    const conn = fakeConnection();
    hub.handleMessage(conn, { type: "hello", name: "ไร้ฐานข้อมูล" });
    hub.handleMessage(conn, { type: "play_ai", level: "easy" });
    expect(lastOf(conn, "match_start")).toBeDefined();
    expect(await nullStore.recentMatches("any")).toEqual([]);
    hub.dispose();
  });

  test("ไม่ตั้ง DATABASE_URL แล้ว PrismaStore.fromEnv คืน null", async () => {
    expect(await PrismaStore.fromEnv(undefined)).toBeNull();
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

interface Recorder extends Connection {
  messages: ServerMessage[];
}

function fakeConnection(): Recorder {
  const messages: ServerMessage[] = [];
  return {
    id: `store_conn_${Math.random()}`,
    sessionId: null,
    messages,
    send(message) {
      messages.push(message);
    },
    close() {},
  };
}

function lastOf<T extends ServerMessage["type"]>(
  conn: Recorder,
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  for (let i = conn.messages.length - 1; i >= 0; i--) {
    if (conn.messages[i].type === type) return conn.messages[i] as Extract<ServerMessage, { type: T }>;
  }
  return undefined;
}

function playTurn(hub: Hub, conn: Recorder): void {
  let state = lastOf(conn, "state")!.state;
  for (const square of state.selectable) {
    hub.handleMessage(conn, { type: "select", square });
    state = lastOf(conn, "state")!.state;
    if (state.targetKind === "capture") break;
  }
  while (state.status === "active" && state.selection) {
    if (state.targets.length === 0) break;
    const kind = state.targetKind === "capture" ? "capture" : "move";
    hub.handleMessage(conn, { type: kind, to: state.targets[0] } as never);
    state = lastOf(conn, "state")!.state;
  }
}
