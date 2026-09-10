/**
 * คำแปล
 *
 * เซิร์ฟเวอร์ส่งมาแค่รหัสกับค่าประกอบ ตัวข้อความมาจากแคตตาล็อกที่ดึงมาแคชไว้
 * รหัสที่ไม่รู้จักให้แสดงรหัสตรง ๆ แทนที่จะเงียบ เพราะเซิร์ฟเวอร์อาจใหม่กว่าหน้าเว็บ
 */

import type { MessageParams } from "../api/types";

let catalog: Record<string, string> = {};

const LOCALE_KEY = "makthai.locale";

export function preferredLocale(): string {
  const saved = localStorage.getItem(LOCALE_KEY);
  if (saved) return saved;
  return navigator.language?.toLowerCase().startsWith("th") ? "th" : "en";
}

export function setLocale(locale: string): void {
  localStorage.setItem(LOCALE_KEY, locale);
}

export async function loadCatalog(locale = preferredLocale()): Promise<void> {
  try {
    const response = await fetch(`/api/v1/messages?locale=${encodeURIComponent(locale)}`);
    const body = (await response.json()) as { messages?: Record<string, string> };
    catalog = body.messages ?? {};
  } catch {
    catalog = {};
  }
}

/** ใส่แคตตาล็อกเองสำหรับเทสต์ */
export function setCatalog(messages: Record<string, string>): void {
  catalog = messages;
}

export function t(code: string, params: MessageParams = {}): string {
  const template = catalog[code];
  if (!template) return code;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    if (value === undefined) return whole;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

/** ชื่อผู้เล่นที่คนอ่าน — เซิร์ฟเวอร์ส่งชื่อบอทเป็นกลางทางภาษามา */
export function playerName(player?: { name: string; bot?: string } | null): string {
  if (!player) return t("departed_player");
  if (player.bot) return t(`ai_${player.bot}`);
  return player.name || t("departed_player");
}

export function gameName(gameId: string): string {
  return t(`game_${gameId}`);
}

export function gameTagline(gameId: string): string {
  return t(`tagline_${gameId}`);
}
