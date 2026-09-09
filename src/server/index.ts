/**
 * Transport layer: HTTP static + WebSocket
 * ทำหน้าที่แค่รับส่งข้อความ ตรรกะทั้งหมดอยู่ใน Hub และ Game Engine
 */

import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { Hub, type Connection } from "./hub.js";
import type { ServerMessage } from "./protocol.js";
import { type MatchStore, NullStore, PrismaStore } from "./store.js";
import { normalizeUsername, resolveAuthSecret, signToken, validateCredentials, verifyToken } from "./auth.js";
import { type Cluster, LocalCluster, RedisCluster } from "./cluster.js";
import { GoogleVerifier } from "./google.js";
import { type Mailer, mailerFromEnv, otpEmail } from "./mailer.js";
import { isValidEmail, normalizeEmail } from "./otp.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { DEFAULT_LOCALE, type Locale, LOCALES, catalogFor, isLocale } from "./messages.js";
import { sanitizeName } from "./ids.js";

const PORT = Number(process.env.PORT ?? 3000);
const API_VERSION = 1;

/**
 * client อื่น (แอปมือถือ) ต่อเข้ามาจากคนละ origin จึงต้องเปิด CORS
 * ใช้ bearer token ไม่ใช่ cookie การเปิดกว้างจึงไม่เปิดช่อง CSRF
 */
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "*").split(",").map((value) => value.trim());

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = CORS_ORIGINS.includes("*")
    ? "*"
    : origin && CORS_ORIGINS.includes(origin)
      ? origin
      : CORS_ORIGINS[0] ?? "";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;

// ไม่ตั้ง DATABASE_URL ก็เล่นได้ครบทุกอย่าง แค่ไม่มีประวัติข้ามการรีสตาร์ต
const store: MatchStore = (await PrismaStore.fromEnv()) ?? new NullStore();
console.log(
  store instanceof NullStore
    ? "ไม่ได้ตั้ง DATABASE_URL — จะไม่บันทึกประวัติลงฐานข้อมูล"
    : "เชื่อมต่อฐานข้อมูลแล้ว",
);

const mailer: Mailer = mailerFromEnv();
const google = new GoogleVerifier({
  clientIds: (process.env.GOOGLE_CLIENT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
});
if (google.enabled) console.log("เปิดล็อกอินด้วย Google แล้ว");

const { secret: AUTH_SECRET, ephemeral } = resolveAuthSecret();
if (ephemeral && store.supportsAccounts) {
  console.warn(
    "ไม่ได้ตั้ง AUTH_SECRET — สุ่มใหม่ทุกครั้งที่รีสตาร์ต ผู้ใช้จะหลุดล็อกอิน และหลาย node จะตรวจ token ของกันไม่ได้",
  );
}

/**
 * หลาย node ต้องใช้ Redis ร่วมกัน และแต่ละ node ต้องมี URL ที่ client ต่อตรงเข้ามาได้
 * เพราะแมตช์อยู่ node เดียว การ redirect จึงต้องรู้ที่อยู่จริงของแต่ละ node
 */
const NODE_ID = process.env.NODE_ID ?? `node_${crypto.randomUUID().slice(0, 8)}`;
const NODE_URL = process.env.NODE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL;

const cluster: Cluster = REDIS_URL
  ? await RedisCluster.connect({ url: REDIS_URL, nodeId: NODE_ID, nodeUrl: NODE_URL })
  : new LocalCluster(NODE_ID, NODE_URL);

if (REDIS_URL && !NODE_URL) {
  console.warn("ตั้ง REDIS_URL แล้วแต่ไม่ได้ตั้ง NODE_URL — client จะถูก redirect ไป node อื่นไม่ได้");
}
console.log(cluster.distributed ? `โหมดหลาย node · ${NODE_ID}` : "โหมด node เดียว");

const hub = new Hub({
  cluster,
  baseUrl: process.env.PUBLIC_URL ?? `http://localhost:${PORT}`,
  defaultTurnSeconds: Number(process.env.TURN_SECONDS ?? 45),
  authSecret: AUTH_SECRET,
  store,
});

function issue(user: { id: string; name: string }) {
  return signToken({ sub: user.id, name: user.name }, AUTH_SECRET);
}

/** ส่ง OTP ให้อีเมลนี้ — ไม่บอกผู้เรียกว่าอีเมลมีอยู่จริงไหม */
async function sendOtp(email: string, locale: Locale): Promise<void> {
  const issued = await store.issueOtp(email);
  if (!issued.ok) return;
  await mailer
    .send({ to: email, ...otpEmail(issued.code, issued.expiresInMinutes, locale) })
    .catch((error) => console.error("mail delivery failed", error));
}

/** ภาษาที่ผู้ใช้อยากได้ — จาก body หรือ Accept-Language */
function localeOf(request: Request, body: Record<string, unknown> = {}): Locale {
  if (isLocale(body.locale)) return body.locale;
  const header = request.headers.get("accept-language") ?? "";
  return header.toLowerCase().startsWith("th") ? "th" : DEFAULT_LOCALE;
}

/**
 * จำกัดจำนวนครั้งของ endpoint ที่ยิงเดารหัสผ่านได้
 * เก็บใน memory ของ node เดียว — พอสำหรับกันสคริปต์เดาสุ่ม แต่ถ้ากระจายหลาย node
 * ควรย้ายไปนับรวมกันที่ Redis
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.resetAt < now) attempts.delete(key);
}, 60_000).unref?.();

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clientKey(request: Request, server: { requestIP(request: Request): { address: string } | null }): string {
  return server.requestIP(request)?.address ?? "unknown";
}

interface SocketData {
  conn: Connection;
}

let connectionSeq = 0;

function makeConnection(socket: ServerWebSocket<SocketData>): Connection {
  return {
    id: `conn_${++connectionSeq}`,
    sessionId: null,
    send(message: ServerMessage) {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const relative = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(PUBLIC_DIR, relative));
  if (await file.exists()) return new Response(file);
  return new Response("Not found", { status: 404 });
}

const server = Bun.serve<SocketData>({
  port: PORT,
  async fetch(request, srv) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("origin"));

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // รองรับทั้ง /api/... และ /api/v1/... เพื่อให้ client เก่ายังใช้ได้เมื่อขึ้นเวอร์ชันใหม่
    if (url.pathname.startsWith(`/api/v${API_VERSION}/`)) {
      url.pathname = url.pathname.replace(`/api/v${API_VERSION}/`, "/api/");
    }

    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: cors });

    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(request, { data: {} as SocketData });
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, node: NODE_ID, distributed: cluster.distributed, ...hub.stats });
    }

    // แคตตาล็อกข้อความ — client จะดึงไปใช้หรือจะแปลเองก็ได้
    if (url.pathname === "/api/messages") {
      const requested = url.searchParams.get("locale");
      const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
      return json(
        { locale, available: LOCALES, messages: catalogFor(locale) },
        200,
      );
    }

    if (url.pathname === "/api/config") {
      return json({
        apiVersion: API_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        accounts: store.supportsAccounts,
        google: google.enabled,
        // client id ของฝั่งเว็บ ใช้เริ่ม Google Identity Services ในเบราว์เซอร์
        googleClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? "",
        emailVerification: store.supportsAccounts,
        maxPlayers: 4,
        modes: ["assisted", "standard", "table"],
        locales: LOCALES,
        defaultLocale: DEFAULT_LOCALE,
      });
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      if (!rateLimit(`register:${clientKey(request, srv)}`, 5, 60 * 60 * 1000)) {
        return json({ code: "rate_limited" }, 429);
      }
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? "");

      // สมัครด้วยอีเมลเป็นทางหลัก ส่วนชื่อผู้ใช้ล้วนยังรองรับไว้ให้ client เก่า
      if (email) {
        if (!isValidEmail(email)) return json({ code: "invalid_email", field: "email" }, 400);
        const invalid = validateCredentials("placeholder", password);
        if (invalid && invalid.field === "password") return json({ code: invalid.code, field: "password" }, 400);

        const displayName = sanitizeName(body.displayName, email.split("@")[0]);
        const outcome = await store.registerWithEmail(email, password, displayName);
        if (!outcome.ok) return json({ code: outcome.code }, 409);
        await sendOtp(email, localeOf(request, body));
        return json({
          token: issue(outcome.user),
          user: outcome.user,
          verificationRequired: true,
          code: "verification_sent",
        });
      }

      const username = normalizeUsername(body.username);
      const invalid = validateCredentials(username, password);
      if (invalid) return json({ code: invalid.code, field: invalid.field }, 400);

      const displayName = sanitizeName(body.displayName, username);
      const outcome = await store.registerUser(username, password, displayName);
      if (!outcome.ok) return json({ code: outcome.code }, 409);
      return json({ token: issue(outcome.user), user: outcome.user, verificationRequired: false });
    }

    if (url.pathname === "/api/auth/verify-otp" && request.method === "POST") {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      if (!rateLimit(`otp:${email || clientKey(request, srv)}`, 10, 15 * 60 * 1000)) {
        return json({ code: "rate_limited" }, 429);
      }
      const outcome = await store.verifyOtp(email, String(body.code ?? ""));
      if (!outcome.ok) return json({ code: outcome.code }, 400);
      return json({ token: issue(outcome.user), user: outcome.user });
    }

    if (url.pathname === "/api/auth/resend-otp" && request.method === "POST") {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      if (!rateLimit(`resend:${email || clientKey(request, srv)}`, 3, 15 * 60 * 1000)) {
        return json({ code: "rate_limited" }, 429);
      }
      await sendOtp(email, localeOf(request, body));
      // ตอบเหมือนกันเสมอ จะได้ไม่ใช้ endpoint นี้ไล่เช็คว่าอีเมลไหนมีบัญชีอยู่
      return json({ ok: true, code: "otp_sent" });
    }

    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      if (!google.enabled) return json({ code: "google_disabled" }, 400);
      if (!rateLimit(`google:${clientKey(request, srv)}`, 20, 10 * 60 * 1000)) {
        return json({ code: "rate_limited" }, 429);
      }
      const body = await readJson(request);
      const identity = await google.verify(body.idToken);
      if (!identity) return json({ code: "google_invalid" }, 401);

      const outcome = await store.loginWithGoogle(identity);
      if (!outcome.ok) return json({ code: outcome.code }, 401);
      return json({ token: issue(outcome.user), user: outcome.user });
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!rateLimit(`login:${clientKey(request, srv)}`, 10, 10 * 60 * 1000)) {
        return json({ code: "rate_limited" }, 429);
      }
      const body = await readJson(request);
      const outcome = await store.loginUser(String(body.username ?? body.email ?? ""), String(body.password ?? ""));
      if (!outcome.ok) return json({ code: outcome.code }, 401);
      return json({ token: issue(outcome.user), user: outcome.user });
    }

    if (url.pathname === "/api/me") {
      const payload = verifyToken(request.headers.get("authorization")?.replace(/^Bearer /, ""), AUTH_SECRET);
      if (!payload) return json({ code: "unauthorized" }, 401);
      const user = await store.getUser(payload.sub);
      if (!user) return json({ code: "user_not_found" }, 404);
      return json({ user });
    }

    // ค้นหาผู้เล่นเพื่อเพิ่มเป็นเพื่อน — ต้องล็อกอินก่อน จะได้ไม่ถูกใช้ไล่ดูรายชื่อทั้งระบบ
    if (url.pathname === "/api/players/search") {
      const payload = verifyToken(request.headers.get("authorization")?.replace(/^Bearer /, ""), AUTH_SECRET);
      if (!payload) return json({ code: "unauthorized" }, 401);
      const query = url.searchParams.get("q") ?? "";
      return json({ players: await store.searchPlayers(query, payload.sub, 20) });
    }

    if (url.pathname === "/api/friends") {
      const payload = verifyToken(request.headers.get("authorization")?.replace(/^Bearer /, ""), AUTH_SECRET);
      if (!payload) return json({ code: "unauthorized" }, 401);
      return json(await store.listFriends(payload.sub));
    }

    if (url.pathname === "/api/leaderboard") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ leaderboard: await store.leaderboard(limit) });
    }

    // ประวัติการแข่งของผู้เล่นหนึ่งคน (ต้องมีฐานข้อมูลถึงจะมีข้อมูล)
    const historyMatch = url.pathname.match(/^\/api\/players\/([\w-]{1,64})\/matches$/);
    if (historyMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      try {
        return json({ matches: await hub.store.recentMatches(historyMatch[1], limit) });
      } catch (error) {
        console.error("history error", error);
        return json({ code: "history_failed" }, 500);
      }
    }

    // ลิงก์เชิญ: /join/K4D8Q2 → เสิร์ฟหน้าเกม แล้ว client อ่านรหัสจาก path เอง
    if (url.pathname.startsWith("/join/")) return serveStatic("/index.html");

    return serveStatic(url.pathname);
  },
  websocket: {
    open(socket) {
      socket.data.conn = makeConnection(socket);
    },
    message(socket, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        socket.data.conn.send({ type: "error", code: "not_json" });
        return;
      }
      try {
        hub.handleMessage(socket.data.conn, parsed);
      } catch (error) {
        console.error("hub error", error);
        socket.data.conn.send({ type: "error", code: "server_error" });
      }
    },
    close(socket) {
      if (socket.data.conn) hub.handleClose(socket.data.conn);
    },
  },
});

console.log(`หมากสี่กระดาน — เซิร์ฟเวอร์พร้อมที่ http://localhost:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.dispose();
    server.stop(true);
    // เขียนงานที่ค้างให้จบก่อนปิด ไม่งั้นเทิร์นท้าย ๆ จะหายไปจากประวัติ
    hub
      .flush()
      .finally(() => store.close())
      .finally(() => process.exit(0));
  });
}
