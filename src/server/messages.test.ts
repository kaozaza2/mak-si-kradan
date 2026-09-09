import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCALE, LOCALES, MESSAGES, catalogFor, isLocale, renderMessage } from "./messages.js";

const SOURCE_DIRS = [new URL("./", import.meta.url).pathname, new URL("../engine/", import.meta.url).pathname];
/** เว็บ client ก็เป็นผู้ใช้แคตตาล็อกนี้ บาง code จึงถูกใช้ที่ฝั่งนั้นเท่านั้น */
const CLIENT_FILE = new URL("../../public/app.js", import.meta.url).pathname;

/** ซอร์สทั้งหมดของ server กับ engine รวมเป็นก้อนเดียว */
function allSource(): string {
  const chunks: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "messages.ts") continue;
      chunks.push(readFileSync(join(dir, file), "utf8"));
    }
  }
  chunks.push(readFileSync(CLIENT_FILE, "utf8"));
  return chunks.join("\n");
}

/** code ที่ถูกส่งออกไปแบบเขียนตรง ๆ ในโค้ด */
function emittedCodes(source: string): Set<string> {
  const codes = new Set<string>();
  for (const match of source.matchAll(/\bcode: "([a-z_]+)"/g)) codes.add(match[1]);
  for (const match of source.matchAll(/\bfail\("([a-z_]+)"/g)) codes.add(match[1]);
  return codes;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("แคตตาล็อกข้อความ", () => {
  test("ทุก code มีครบทุกภาษาและไม่ว่าง", () => {
    for (const [code, translations] of Object.entries(MESSAGES)) {
      for (const locale of LOCALES) {
        expect(translations[locale], `${code}/${locale}`).toBeTruthy();
        expect(translations[locale].trim().length, `${code}/${locale}`).toBeGreaterThan(0);
      }
    }
  });

  test("ตัวแปรในข้อความตรงกันทุกภาษา ไม่งั้นแปลแล้วค่าหาย", () => {
    for (const [code, translations] of Object.entries(MESSAGES)) {
      const reference = placeholders(translations[DEFAULT_LOCALE]);
      for (const locale of LOCALES) {
        expect(placeholders(translations[locale]), `${code}/${locale}`).toEqual(reference);
      }
    }
  });

  test("ทุก code ที่ server ส่งออกไปมีข้อความรองรับ", () => {
    const missing = [...emittedCodes(allSource())].filter((code) => !MESSAGES[code]);
    expect(missing).toEqual([]);
  });

  test("ไม่มีข้อความที่ไม่มีใครใช้ค้างอยู่", () => {
    // บาง code ถูกส่งผ่านตัวแปร (เช่น onLeaveRoom(session, "room_closed_you_left"))
    // จึงเช็คแค่ว่าชื่อ code ปรากฏอยู่ในซอร์สจริงหรือไม่
    const source = allSource();
    // และบางกลุ่มถูกประกอบตอนรันไทม์ เช่น t(`ai_${level}`) — ยกเว้นให้เป็นกลุ่ม
    // แต่ยังบังคับว่าตัวประกอบนั้นต้องมีอยู่จริงในซอร์ส กันรายการยกเว้นเน่า
    const dynamicPrefixes = ["ai_"];
    for (const prefix of dynamicPrefixes) expect(source, `ไม่พบการประกอบ ${prefix}`).toContain(`\`${prefix}$`);

    const unused = Object.keys(MESSAGES).filter(
      (code) =>
        !source.includes(`"${code}"`) &&
        !source.includes(`\`${code}\``) &&
        !dynamicPrefixes.some((prefix) => code.startsWith(prefix)),
    );
    expect(unused).toEqual([]);
  });

  test("เติมค่าลงในข้อความได้ รวมถึงรายการหลายค่า", () => {
    expect(renderMessage("not_your_turn", {}, "en")).toBe("It is not your turn");
    expect(renderMessage("room_not_found", { code: "K4D8Q2" }, "th")).toContain("K4D8Q2");
    expect(renderMessage("illegal_jump", { squares: ["c4", "e6"] }, "en")).toContain("c4, e6");
    expect(renderMessage("protocol_mismatch", { server: 1, client: 2 }, "en")).toContain("server 1, client 2");
  });

  test("code ที่ไม่รู้จักคืน code เดิม ไม่ระเบิด", () => {
    expect(renderMessage("ไม่มีอยู่จริง")).toBe("ไม่มีอยู่จริง");
  });

  test("ไม่ส่ง param มาก็ไม่ทำให้ข้อความพัง", () => {
    expect(renderMessage("room_not_found", {}, "en")).toBe("No room with code {code}");
  });

  test("แคตตาล็อกต่อภาษามีครบทุก code", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogFor(locale)).sort()).toEqual(Object.keys(MESSAGES).sort());
    }
  });

  test("isLocale กันค่าที่ไม่รองรับ", () => {
    expect(isLocale("th")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
