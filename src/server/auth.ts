/**
 * บัญชีผู้ใช้ — แฮชรหัสผ่านและ token แบบไม่ต้องเก็บ session ฝั่ง server
 *
 * token เซ็นด้วย HMAC และพก id กับชื่อไว้ในตัว การยืนยันตัวตนจึงไม่ต้องแตะ
 * database เลย ซึ่งจำเป็นสำหรับการกระจายหลาย node — node ไหนก็ตรวจ token ได้
 * ตราบใดที่ถือ secret เดียวกัน
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthPayload {
  /** player id */
  sub: string;
  name: string;
  /** guest = ตัวตนชั่วคราว, user = บัญชีที่สมัครไว้ */
  kind: "guest" | "user";
  /** หมดอายุเมื่อไร (epoch ms) */
  exp: number;
}

export interface CredentialError {
  field: "username" | "password" | "displayName";
  /** code สำหรับให้ client แปลเอง ไม่ใช่ข้อความสำเร็จรูป */
  code: string;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** ตรวจรูปแบบก่อนแตะ database เพื่อให้ข้อความผิดพลาดชัดและกัน input แปลก ๆ */
export function validateCredentials(username: string, password: unknown): CredentialError | null {
  if (!USERNAME_PATTERN.test(username)) {
    return { field: "username", code: "invalid_username" };
  }
  if (typeof password !== "string" || password.length < 8) {
    return { field: "password", code: "weak_password" };
  }
  if (password.length > 200) {
    return { field: "password", code: "password_too_long" };
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signToken(
  payload: Omit<AuthPayload, "exp" | "kind"> & { kind?: "guest" | "user" },
  secret: string,
  ttlMs = TOKEN_TTL_MS,
): string {
  const body = Buffer.from(
    JSON.stringify({ kind: "user", ...payload, exp: Date.now() + ttlMs }),
  ).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token: unknown, secret: string): AuthPayload | null {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(body, secret), "base64url");
  // เทียบแบบเวลาคงที่ กัน timing attack ที่ค่อย ๆ เดาลายเซ็นทีละไบต์
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as AuthPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.kind !== "guest" && payload.kind !== "user") return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * secret สำหรับเซ็น token — ถ้าไม่ตั้งไว้จะสุ่มใหม่ทุกครั้งที่รีสตาร์ต
 * ซึ่งแปลว่าทุกคนหลุดล็อกอิน และหลาย node จะตรวจ token ของกันและกันไม่ได้
 */
export function resolveAuthSecret(value = process.env.AUTH_SECRET): { secret: string; ephemeral: boolean } {
  if (value && value.length >= 16) return { secret: value, ephemeral: false };
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}
