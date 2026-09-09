import { randomBytes, randomUUID } from "node:crypto";

/** ตัวอักษรที่อ่านผิดยาก (ไม่มี 0 O 1 I) สำหรับ room code ที่ต้องบอกกันปากเปล่า */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function roomCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function guestId(): string {
  return `guest_${randomBytes(3).toString("hex")}`;
}

export function sessionToken(): string {
  return randomBytes(24).toString("base64url");
}

export function uuid(): string {
  return randomUUID();
}

const GUEST_NAMES = [
  "Fox", "Tiger", "Moon", "Comet", "Otter", "Falcon", "Panda", "Koi",
  "Nova", "Heron", "Lynx", "Maple", "Rider", "Sable", "Wren", "Zephyr",
];

export function guestName(): string {
  const pick = GUEST_NAMES[randomBytes(1)[0] % GUEST_NAMES.length];
  return `Guest ${pick}`;
}

/** ตัดชื่อที่ผู้เล่นตั้งเองให้อยู่ในขอบเขตที่ปลอดภัยต่อการแสดงผล */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.replace(/[\p{C}]/gu, "").trim().slice(0, 20);
  return trimmed.length >= 1 ? trimmed : fallback;
}
