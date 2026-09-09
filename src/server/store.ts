/**
 * ชั้นเก็บข้อมูลถาวร
 *
 * Hub ไม่ผูกกับ Prisma โดยตรง แต่คุยผ่าน interface นี้ เกมจึงรันได้โดยไม่ต้องมี
 * database เลย (NullStore) และการเขียนลง DB ต้องไม่มีวันทำให้เกมสะดุด —
 * ทุกการเรียกเป็น fire-and-forget ที่กลืน error เองทั้งหมด
 */

import type { EndReason, GameState, TurnRecord } from "../engine/index.js";
import { hashPassword, verifyPassword } from "./auth.js";
import type { GoogleIdentity } from "./google.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES, generateOtp, hashOtp, normalizeEmail, verifyOtpHash } from "./otp.js";
import { DEFAULT_RATING, computeRatingChanges } from "./rating.js";

export interface StoredSession {
  id: string;
  name: string;
  kind: string;
}

export interface StoredMatchPlayer {
  seat: number;
  playerId: string;
  name: string;
  isBot: boolean;
  botLevel: string | null;
}

export interface StoredMatch {
  id: string;
  source: "quick" | "room" | "challenge" | "ai";
  playerCount: number;
  turnSeconds: number;
  players: StoredMatchPlayer[];
}

export interface StoredResult {
  reason: EndReason;
  scores: number[];
  winners: number[];
  retired: number[];
  turns: number;
  state: GameState;
}

export interface MatchSummary {
  id: string;
  source: string;
  reason: string | null;
  turns: number;
  startedAt: Date;
  endedAt: Date | null;
  players: { seat: number; name: string; score: number; winner: boolean; isBot: boolean }[];
}

export interface StoredUser {
  id: string;
  name: string;
  username: string;
  email: string | null;
  /** ยืนยันอีเมลแล้วหรือยัง — ต้องยืนยันก่อนถึงจะเก็บ rating ได้ */
  verified: boolean;
  /** ผูกบัญชี Google ไว้แล้วหรือยัง */
  google: boolean;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface LeaderboardRow extends StoredUser {
  rank: number;
}

/** สรุปผู้เล่นแบบสั้นสำหรับรายชื่อเพื่อนและผลค้นหา */
export interface PlayerSummary {
  id: string;
  name: string;
  username: string;
  rating: number;
}

export interface FriendRequestRow {
  requestId: string;
  player: PlayerSummary;
  createdAt: Date;
}

export interface FriendList {
  friends: PlayerSummary[];
  /** คำขอที่คนอื่นส่งมาหาเรา */
  incoming: FriendRequestRow[];
  /** คำขอที่เราส่งออกไป */
  outgoing: FriendRequestRow[];
}

export type FriendOutcome =
  | { ok: true; status: "pending" | "accepted"; player: PlayerSummary }
  | { ok: false; code: string };

export type AuthOutcome =
  | { ok: true; user: StoredUser }
  /** code เท่านั้น ไม่ใช่ข้อความ — ผู้เรียกเป็นคนเลือกภาษาเอง */
  | { ok: false; code: string };

/** รหัส OTP ที่เพิ่งออก — ผู้เรียกเป็นคนส่งอีเมลเอง store ไม่ยุ่งกับการส่ง */
export type OtpIssue =
  | { ok: true; code: string; expiresInMinutes: number }
  | { ok: false; reason: string };

export interface MatchStore {
  /** รองรับบัญชีผู้ใช้หรือไม่ — false เมื่อไม่ได้ต่อฐานข้อมูล */
  readonly supportsAccounts: boolean;
  registerUser(username: string, password: string, displayName: string): Promise<AuthOutcome>;
  registerWithEmail(email: string, password: string, displayName: string): Promise<AuthOutcome>;
  issueOtp(email: string, purpose?: string): Promise<OtpIssue>;
  verifyOtp(email: string, code: string, purpose?: string): Promise<AuthOutcome>;
  loginWithGoogle(identity: GoogleIdentity): Promise<AuthOutcome>;
  /** ล็อกอินด้วยอีเมลหรือชื่อผู้ใช้ก็ได้ */
  loginUser(identifier: string, password: string): Promise<AuthOutcome>;
  getUser(id: string): Promise<StoredUser | null>;
  leaderboard(limit?: number): Promise<LeaderboardRow[]>;
  searchPlayers(query: string, excludeId: string, limit?: number): Promise<PlayerSummary[]>;
  listFriends(userId: string): Promise<FriendList>;
  friendIds(userId: string): Promise<string[]>;
  requestFriend(userId: string, identifier: string): Promise<FriendOutcome>;
  respondFriend(userId: string, requestId: string, accept: boolean): Promise<FriendOutcome>;
  removeFriend(userId: string, otherId: string): Promise<{ ok: boolean }>;
  areFriends(a: string, b: string): Promise<boolean>;
  saveSession(session: StoredSession): Promise<void>;
  createMatch(match: StoredMatch): Promise<void>;
  recordActions(matchId: string, actions: TurnRecord[]): Promise<void>;
  finishMatch(matchId: string, result: StoredResult): Promise<void>;
  recentMatches(playerId: string, limit?: number): Promise<MatchSummary[]>;
  close(): Promise<void>;
}

/** ใช้เมื่อไม่ได้ตั้ง DATABASE_URL — เกมทำงานครบทุกอย่าง แค่ไม่เก็บอะไรไว้ */
export class NullStore implements MatchStore {
  readonly supportsAccounts = false;
  async registerUser(): Promise<AuthOutcome> {
    return NullStore.disabled;
  }
  async registerWithEmail(): Promise<AuthOutcome> {
    return NullStore.disabled;
  }
  async issueOtp(): Promise<OtpIssue> {
    return { ok: false, reason: "accounts_disabled" };
  }
  async verifyOtp(): Promise<AuthOutcome> {
    return NullStore.disabled;
  }
  async loginWithGoogle(): Promise<AuthOutcome> {
    return NullStore.disabled;
  }
  async loginUser(): Promise<AuthOutcome> {
    return NullStore.disabled;
  }
  private static readonly disabled: AuthOutcome = { ok: false, code: "accounts_disabled" };
  async getUser(): Promise<StoredUser | null> {
    return null;
  }
  async leaderboard(): Promise<LeaderboardRow[]> {
    return [];
  }
  async searchPlayers(): Promise<PlayerSummary[]> {
    return [];
  }
  async listFriends(): Promise<FriendList> {
    return { friends: [], incoming: [], outgoing: [] };
  }
  async friendIds(): Promise<string[]> {
    return [];
  }
  async requestFriend(): Promise<FriendOutcome> {
    return { ok: false, code: "accounts_disabled" };
  }
  async respondFriend(): Promise<FriendOutcome> {
    return { ok: false, code: "accounts_disabled" };
  }
  async removeFriend(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  async areFriends(): Promise<boolean> {
    return false;
  }
  async saveSession(): Promise<void> {}
  async createMatch(): Promise<void> {}
  async recordActions(): Promise<void> {}
  async finishMatch(): Promise<void> {}
  async recentMatches(): Promise<MatchSummary[]> {
    return [];
  }
  async close(): Promise<void> {}
}

export class PrismaStore implements MatchStore {
  readonly supportsAccounts = true;

  constructor(private readonly prisma: PrismaLike) {}

  /** สร้าง store จาก DATABASE_URL — คืน null ถ้าไม่ได้ตั้งค่าไว้ */
  static async fromEnv(url = process.env.DATABASE_URL): Promise<PrismaStore | null> {
    if (!url) return null;
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    return new PrismaStore(prisma as unknown as PrismaLike);
  }

  async registerUser(username: string, password: string, displayName: string): Promise<AuthOutcome> {
    const existing = await this.prisma.player.findUnique({ where: { username } });
    if (existing) return { ok: false, code: "username_taken" };

    const created = await this.prisma.player.create({
      data: {
        id: `user_${crypto.randomUUID()}`,
        name: displayName,
        kind: "user",
        username,
        passwordHash: await hashPassword(password),
        rating: DEFAULT_RATING,
        // บัญชีที่สมัครด้วยชื่อผู้ใช้ล้วนไม่มีอีเมลให้ยืนยัน จึงถือว่าพร้อมใช้งานเลย
        emailVerifiedAt: new Date(),
      },
    });
    return { ok: true, user: toUser(created) };
  }

  async registerWithEmail(email: string, password: string, displayName: string): Promise<AuthOutcome> {
    const normalized = normalizeEmail(email);
    const existing = await this.prisma.player.findUnique({ where: { email: normalized } });
    if (existing) return { ok: false, code: "email_taken" };

    const created = await this.prisma.player.create({
      data: {
        id: `user_${crypto.randomUUID()}`,
        name: displayName,
        kind: "user",
        email: normalized,
        passwordHash: await hashPassword(password),
        rating: DEFAULT_RATING,
      },
    });
    return { ok: true, user: toUser(created) };
  }

  /**
   * ออกรหัส OTP ใหม่ และยกเลิกรหัสเก่าของอีเมลนี้ทิ้ง
   * เพื่อไม่ให้มีรหัสหลายตัวใช้ได้พร้อมกัน ซึ่งเพิ่มโอกาสเดาถูกโดยไม่จำเป็น
   */
  async issueOtp(email: string, purpose = "verify_email"): Promise<OtpIssue> {
    const normalized = normalizeEmail(email);
    const player = await this.prisma.player.findUnique({ where: { email: normalized } });
    if (!player) return { ok: false, reason: "email_not_found" };
    if (purpose === "verify_email" && player.emailVerifiedAt) {
      return { ok: false, reason: "email_already_verified" };
    }

    await this.prisma.otpCode.deleteMany({ where: { email: normalized, purpose, consumedAt: null } });
    const code = generateOtp();
    await this.prisma.otpCode.create({
      data: {
        email: normalized,
        codeHash: hashOtp(normalized, code),
        purpose,
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      },
    });
    return { ok: true, code, expiresInMinutes: OTP_TTL_MINUTES };
  }

  async verifyOtp(email: string, code: string, purpose = "verify_email"): Promise<AuthOutcome> {
    const normalized = normalizeEmail(email);
    const record = await this.prisma.otpCode.findFirst({
      where: { email: normalized, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const invalid: AuthOutcome = { ok: false, code: "otp_invalid" };
    if (!record) return invalid;

    if (record.expiresAt.getTime() < Date.now()) {
      await this.prisma.otpCode.delete({ where: { id: record.id } });
      return invalid;
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      // กรอกผิดจนครบโควตาแล้ว ทิ้งรหัสนี้ไปเลย ต้องขอใหม่
      await this.prisma.otpCode.delete({ where: { id: record.id } });
      return { ok: false, code: "otp_too_many_attempts" };
    }
    if (!verifyOtpHash(normalized, String(code), record.codeHash)) {
      await this.prisma.otpCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
      return invalid;
    }

    await this.prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    const player = await this.prisma.player.update({
      where: { email: normalized },
      data: { emailVerifiedAt: new Date() },
    });
    return { ok: true, user: toUser(player) };
  }

  /**
   * ล็อกอินด้วย Google
   *
   * ถ้าอีเมลตรงกับบัญชีที่ยืนยันแล้วจะผูกเข้าด้วยกัน ไม่สร้างบัญชีซ้ำ
   * แต่จะผูกก็ต่อเมื่อฝั่ง Google ยืนยันอีเมลนั้นแล้วเท่านั้น ไม่งั้นใครก็อ้าง
   * อีเมลของคนอื่นเพื่อยึดบัญชีได้
   */
  async loginWithGoogle(identity: GoogleIdentity): Promise<AuthOutcome> {
    const linked = await this.prisma.player.findUnique({ where: { googleId: identity.sub } });
    if (linked) {
      await this.prisma.player.update({ where: { id: linked.id }, data: { lastSeenAt: new Date() } });
      return { ok: true, user: toUser(linked) };
    }

    const email = identity.email ? normalizeEmail(identity.email) : null;
    if (email && identity.emailVerified) {
      const existing = await this.prisma.player.findUnique({ where: { email } });
      if (existing) {
        if (!existing.emailVerifiedAt) {
          // บัญชีเดิมยังไม่ได้ยืนยันอีเมล แต่ Google ยืนยันให้แล้ว ถือว่ายืนยันได้
          // เพราะเจ้าของอีเมลตัวจริงเท่านั้นที่ล็อกอิน Google ด้วยอีเมลนี้ได้
          await this.prisma.otpCode.deleteMany({ where: { email, consumedAt: null } });
        }
        const merged = await this.prisma.player.update({
          where: { id: existing.id },
          data: { googleId: identity.sub, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
        });
        return { ok: true, user: toUser(merged) };
      }
    }

    const created = await this.prisma.player.create({
      data: {
        id: `user_${crypto.randomUUID()}`,
        name: identity.name ?? email?.split("@")[0] ?? "ผู้เล่น Google",
        kind: "user",
        email: identity.emailVerified ? email : null,
        googleId: identity.sub,
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
        rating: DEFAULT_RATING,
      },
    });
    return { ok: true, user: toUser(created) };
  }

  async loginUser(identifier: string, password: string): Promise<AuthOutcome> {
    const value = identifier.trim().toLowerCase();
    const player = value.includes("@")
      ? await this.prisma.player.findUnique({ where: { email: value } })
      : await this.prisma.player.findUnique({ where: { username: value } });
    // ข้อความเดียวกันทั้งกรณีไม่มีบัญชีและรหัสผิด จะได้ไม่บอกใบ้ว่าชื่อไหนมีอยู่จริง
    const invalid: AuthOutcome = { ok: false, code: "invalid_credentials" };
    if (!player) {
      // ทำงานเท่า ๆ กันทั้งสองทาง กัน timing attack ที่ใช้เดาว่ามีชื่อนี้ไหม
      await verifyPassword(password, null);
      return invalid;
    }
    if (!(await verifyPassword(password, player.passwordHash))) return invalid;

    await this.prisma.player.update({ where: { id: player.id }, data: { lastSeenAt: new Date() } });
    return { ok: true, user: toUser(player) };
  }

  async getUser(id: string): Promise<StoredUser | null> {
    const player = await this.prisma.player.findUnique({ where: { id } });
    return player && player.kind === "user" ? toUser(player) : null;
  }

  async leaderboard(limit = 50): Promise<LeaderboardRow[]> {
    const players = await this.prisma.player.findMany({
      where: { kind: "user", gamesPlayed: { gt: 0 } },
      orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
      take: Math.min(200, Math.max(1, limit)),
    });
    return players.map((player: Record<string, any>, index: number) => ({ ...toUser(player), rank: index + 1 }));
  }

  async searchPlayers(query: string, excludeId: string, limit = 20): Promise<PlayerSummary[]> {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < 2) return [];
    const players = await this.prisma.player.findMany({
      where: {
        kind: "user",
        id: { not: excludeId },
        OR: [{ username: { contains: trimmed } }, { name: { contains: query.trim() } }],
      },
      orderBy: { rating: "desc" },
      take: Math.min(50, Math.max(1, limit)),
    });
    return players.map(toSummary);
  }

  async listFriends(userId: string): Promise<FriendList> {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      include: { requester: true, addressee: true },
      orderBy: { createdAt: "desc" },
    });

    const list: FriendList = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const other = row.requesterId === userId ? row.addressee : row.requester;
      if (!other) continue;
      if (row.status === "accepted") list.friends.push(toSummary(other));
      else if (row.addresseeId === userId) {
        list.incoming.push({ requestId: row.id, player: toSummary(other), createdAt: row.createdAt });
      } else {
        list.outgoing.push({ requestId: row.id, player: toSummary(other), createdAt: row.createdAt });
      }
    }
    list.friends.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }

  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.friendship.findMany({
      where: { status: "accepted", OR: [{ requesterId: userId }, { addresseeId: userId }] },
    });
    return rows.map((row: Record<string, any>) => (row.requesterId === userId ? row.addresseeId : row.requesterId));
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const row = await this.prisma.friendship.findFirst({
      where: {
        status: "accepted",
        OR: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      },
    });
    return Boolean(row);
  }

  /**
   * ขอเป็นเพื่อน — ระบุด้วย id, ชื่อผู้ใช้ หรืออีเมลก็ได้
   *
   * ถ้าอีกฝ่ายเคยส่งคำขอมาหาเราอยู่แล้ว จะถือว่าตอบรับทันที
   * เพราะทั้งสองฝ่ายแสดงเจตนาตรงกันแล้ว ไม่มีเหตุให้ต้องรออีกขั้น
   */
  async requestFriend(userId: string, identifier: string): Promise<FriendOutcome> {
    const target = await this.resolvePlayer(identifier);
    if (!target || target.kind !== "user") return { ok: false, code: "player_not_found" };
    if (target.id === userId) return { ok: false, code: "friend_self" };

    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userId, addresseeId: target.id },
          { requesterId: target.id, addresseeId: userId },
        ],
      },
    });

    if (existing?.status === "accepted") return { ok: false, code: "already_friends" };
    if (existing) {
      if (existing.requesterId === userId) return { ok: false, code: "friend_request_pending" };
      const accepted = await this.prisma.friendship.update({
        where: { id: existing.id },
        data: { status: "accepted", respondedAt: new Date() },
      });
      return { ok: true, status: "accepted", player: toSummary(target) };
    }

    await this.prisma.friendship.create({ data: { requesterId: userId, addresseeId: target.id } });
    return { ok: true, status: "pending", player: toSummary(target) };
  }

  async respondFriend(userId: string, requestId: string, accept: boolean): Promise<FriendOutcome> {
    const row = await this.prisma.friendship.findUnique({
      where: { id: requestId },
      include: { requester: true },
    });
    // ตอบได้เฉพาะคำขอที่ส่งมาหาเราและยังไม่ถูกตอบ
    if (!row || row.addresseeId !== userId || row.status !== "pending") {
      return { ok: false, code: "friend_request_gone" };
    }

    if (!accept) {
      await this.prisma.friendship.delete({ where: { id: row.id } });
      return { ok: true, status: "pending", player: toSummary(row.requester) };
    }
    await this.prisma.friendship.update({
      where: { id: row.id },
      data: { status: "accepted", respondedAt: new Date() },
    });
    return { ok: true, status: "accepted", player: toSummary(row.requester) };
  }

  async removeFriend(userId: string, otherId: string): Promise<{ ok: boolean }> {
    const result = await this.prisma.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: userId, addresseeId: otherId },
          { requesterId: otherId, addresseeId: userId },
        ],
      },
    });
    return { ok: (result?.count ?? 0) > 0 };
  }

  private async resolvePlayer(identifier: string): Promise<Record<string, any> | null> {
    const value = identifier.trim();
    if (!value) return null;
    if (value.includes("@")) return this.prisma.player.findUnique({ where: { email: value.toLowerCase() } });
    return (
      (await this.prisma.player.findUnique({ where: { username: value.toLowerCase() } })) ??
      (await this.prisma.player.findUnique({ where: { id: value } }))
    );
  }

  async saveSession(session: StoredSession): Promise<void> {
    await this.prisma.player.upsert({
      where: { id: session.id },
      create: { id: session.id, name: session.name, kind: session.kind },
      // บัญชีที่สมัครแล้วเปลี่ยนชื่อผ่านทางนี้ไม่ได้ ชื่อมาจากตอนสมัคร
      update: session.kind === "user" ? { lastSeenAt: new Date() } : { name: session.name, lastSeenAt: new Date() },
    });
  }

  async createMatch(match: StoredMatch): Promise<void> {
    await this.prisma.match.create({
      data: {
        id: match.id,
        source: match.source,
        playerCount: match.playerCount,
        turnSeconds: match.turnSeconds,
        players: {
          create: match.players.map((player) => ({
            seat: player.seat,
            // บอทไม่มีตัวตนถาวร จึงไม่ผูกกับตาราง Player
            playerId: player.isBot ? null : player.playerId,
            name: player.name,
            isBot: player.isBot,
            botLevel: player.botLevel,
          })),
        },
      },
    });
  }

  async recordActions(matchId: string, actions: TurnRecord[]): Promise<void> {
    if (actions.length === 0) return;
    await this.prisma.matchAction.createMany({
      data: actions.map((action) => ({
        matchId,
        turn: action.turn,
        seat: action.player,
        pieceId: action.pieceId,
        kind: action.kind,
        path: JSON.stringify(action.path),
        captures: action.captures,
      })),
    });
  }

  async finishMatch(matchId: string, result: StoredResult): Promise<void> {
    for (let seat = 0; seat < result.scores.length; seat++) {
      await this.prisma.matchPlayer.updateMany({
        where: { matchId, seat },
        data: {
          score: result.scores[seat] ?? 0,
          retired: result.retired.includes(seat),
          winner: result.winners.includes(seat),
        },
      });
    }

    const rated = await this.applyRating(matchId, result);

    await this.prisma.match.update({
      where: { id: matchId },
      data: {
        status: "ended",
        reason: result.reason,
        turns: result.turns,
        rated,
        state: JSON.stringify(result.state),
        endedAt: new Date(),
      },
    });
  }

  /**
   * คิด rating ให้แมตช์ที่จบแล้ว
   *
   * นับเฉพาะแมตช์ที่ทุกที่นั่งเป็นบัญชีที่สมัครแล้ว ไม่มีบอทและไม่มี guest
   * ไม่งั้นเรตติ้งจะไม่มีความหมาย เพราะเก็บแต้มจากบอทได้ไม่จำกัด
   *
   * ที่นั่งที่ AI คุมแทนยังนับ เพราะการทิ้งเกมไปเป็นความรับผิดชอบของเจ้าของที่นั่ง
   */
  private async applyRating(matchId: string, result: StoredResult): Promise<boolean> {
    const seats = await this.prisma.matchPlayer.findMany({
      where: { matchId },
      orderBy: { seat: "asc" },
      include: { player: true },
    });
    if (seats.length < 2) return false;

    // ต้องเป็นบัญชีที่ยืนยันแล้วทุกที่นั่ง ไม่งั้นสมัครใหม่รัว ๆ เพื่อปั่นเรตติ้งได้
    const eligible = seats.every(
      (seat: Record<string, any>) =>
        !seat.isBot && seat.player && seat.player.kind === "user" && seat.player.emailVerifiedAt,
    );
    if (!eligible) return false;

    const changes = computeRatingChanges(
      seats.map((seat: Record<string, any>) => ({
        rating: seat.player.rating,
        score: result.scores[seat.seat] ?? 0,
        retired: result.retired.includes(seat.seat),
        gamesPlayed: seat.player.gamesPlayed,
      })),
    );

    for (const [index, seat] of seats.entries()) {
      const change = changes[index];
      await this.prisma.matchPlayer.update({
        where: { id: seat.id },
        data: { ratingBefore: change.before, ratingAfter: change.after },
      });
      await this.prisma.player.update({
        where: { id: seat.player.id },
        data: {
          rating: change.after,
          gamesPlayed: { increment: 1 },
          wins: { increment: change.outcome === "win" ? 1 : 0 },
          losses: { increment: change.outcome === "loss" ? 1 : 0 },
          draws: { increment: change.outcome === "draw" ? 1 : 0 },
        },
      });
    }
    return true;
  }

  async recentMatches(playerId: string, limit = 20): Promise<MatchSummary[]> {
    const matches = await this.prisma.match.findMany({
      where: { players: { some: { playerId } } },
      orderBy: { startedAt: "desc" },
      take: Math.min(100, Math.max(1, limit)),
      include: { players: { orderBy: { seat: "asc" } } },
    });
    return matches.map((match: Record<string, any>) => ({
      id: match.id,
      source: match.source,
      reason: match.reason,
      turns: match.turns,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      players: match.players.map((player: Record<string, any>) => ({
        seat: player.seat,
        name: player.name,
        score: player.score,
        winner: player.winner,
        isBot: player.isBot,
      })),
    }));
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** โครงหน้าตาของ PrismaClient เท่าที่ store นี้ใช้ ทำให้ mock ใน test ได้ */
export interface PrismaLike {
  player: {
    upsert(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<any>;
    update(args: unknown): Promise<any>;
    findUnique(args: unknown): Promise<any>;
    findMany(args: unknown): Promise<any[]>;
  };
  match: {
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<any[]>;
  };
  matchPlayer: {
    updateMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<any[]>;
  };
  matchAction: { createMany(args: unknown): Promise<unknown> };
  friendship: {
    create(args: unknown): Promise<any>;
    update(args: unknown): Promise<any>;
    delete(args: unknown): Promise<any>;
    deleteMany(args: unknown): Promise<any>;
    findFirst(args: unknown): Promise<any>;
    findUnique(args: unknown): Promise<any>;
    findMany(args: unknown): Promise<any[]>;
  };
  otpCode: {
    create(args: unknown): Promise<any>;
    update(args: unknown): Promise<any>;
    delete(args: unknown): Promise<any>;
    deleteMany(args: unknown): Promise<any>;
    findFirst(args: unknown): Promise<any>;
  };
  $disconnect(): Promise<void>;
}

function toSummary(player: Record<string, any>): PlayerSummary {
  return {
    id: player.id,
    name: player.name,
    username: player.username ?? "",
    rating: player.rating ?? DEFAULT_RATING,
  };
}

function toUser(player: Record<string, any>): StoredUser {
  return {
    id: player.id,
    name: player.name,
    username: player.username ?? "",
    email: player.email ?? null,
    verified: Boolean(player.emailVerifiedAt),
    google: Boolean(player.googleId),
    rating: player.rating ?? DEFAULT_RATING,
    gamesPlayed: player.gamesPlayed ?? 0,
    wins: player.wins ?? 0,
    losses: player.losses ?? 0,
    draws: player.draws ?? 0,
  };
}
