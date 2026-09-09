/**
 * รหัส OTP สำหรับยืนยันอีเมล
 *
 * รหัส 6 หลักเดาได้ 1 ใน ล้าน ซึ่งไม่พอถ้าปล่อยให้ยิงรัว การป้องกันจริงจึงอยู่ที่
 * จำกัดจำนวนครั้งที่กรอกผิด และให้รหัสหมดอายุเร็ว
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/**
 * แฮชรหัสก่อนเก็บ ใช้ SHA-256 ไม่ใช่ argon2 เพราะรหัสมีอายุสั้นมากและต้องตรวจถี่
 * ผูกกับอีเมลด้วย เพื่อไม่ให้รหัสของคนหนึ่งเอาไปใช้กับอีกคนได้
 */
export function hashOtp(email: string, code: string): string {
  return createHash("sha256").update(`${normalizeEmail(email)}:${code}`).digest("hex");
}

export function verifyOtpHash(email: string, code: string, hash: string): boolean {
  const expected = Buffer.from(hashOtp(email, code));
  const actual = Buffer.from(hash);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * ตรวจรูปแบบอีเมลแบบพอประมาณ — ไม่พยายามครอบคลุม RFC ทั้งฉบับ
 * เพราะตัวตรวจจริงคือการที่ผู้ใช้ต้องกรอก OTP ที่ส่งไปให้ได้
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}
