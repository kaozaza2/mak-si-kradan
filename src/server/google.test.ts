/**
 * ทดสอบตัวตรวจ Google ID token ด้วยกุญแจที่สร้างเอง
 * ทำให้ตรวจเส้นทางลายเซ็นและ claim ได้จริงโดยไม่ต้องยิงไปหา Google
 */

import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { GoogleVerifier } from "./google.js";

const CLIENT_ID = "123.apps.googleusercontent.com";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeToken(
  claims: Record<string, unknown> = {},
  options: { kid?: string; alg?: string; key?: typeof privateKey } = {},
): string {
  const header = encode({ alg: options.alg ?? "RS256", kid: options.kid ?? "test-key", typ: "JWT" });
  const payload = encode({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-user-1",
    email: "Player@Example.com",
    email_verified: true,
    name: "ผู้เล่นกูเกิล",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(options.key ?? privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

let fetchCount = 0;
function makeVerifier(clientIds = [CLIENT_ID]) {
  fetchCount = 0;
  return new GoogleVerifier({
    clientIds,
    fetcher: (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
}

describe("GoogleVerifier", () => {
  test("token ที่ถูกต้องผ่าน และคืนอีเมลเป็นตัวพิมพ์เล็ก", async () => {
    const identity = await makeVerifier().verify(makeToken());
    expect(identity).toEqual({
      sub: "google-user-1",
      email: "player@example.com",
      emailVerified: true,
      name: "ผู้เล่นกูเกิล",
    });
  });

  test("ลายเซ็นจากกุญแจอื่นไม่ผ่าน", async () => {
    expect(await makeVerifier().verify(makeToken({}, { key: otherKey }))).toBeNull();
  });

  test("แก้ payload หลังเซ็นแล้วไม่ผ่าน", async () => {
    const token = makeToken();
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${encode({ sub: "attacker", aud: CLIENT_ID })}.${signature}`;
    expect(await makeVerifier().verify(tampered)).toBeNull();
  });

  test("alg none ไม่ผ่าน (กัน alg confusion)", async () => {
    const header = encode({ alg: "none", kid: "test-key" });
    const payload = encode({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "x", exp: 99999999999 });
    expect(await makeVerifier().verify(`${header}.${payload}.`)).toBeNull();
  });

  test("aud ไม่ตรง client id ไม่ผ่าน", async () => {
    expect(await makeVerifier().verify(makeToken({ aud: "someone-else.apps.googleusercontent.com" }))).toBeNull();
  });

  test("รับได้หลาย client id เพราะเว็บกับมือถือใช้คนละตัว", async () => {
    const verifier = makeVerifier(["mobile.apps.googleusercontent.com", CLIENT_ID]);
    expect(await verifier.verify(makeToken())).not.toBeNull();
  });

  test("iss ไม่ใช่ของ Google ไม่ผ่าน", async () => {
    expect(await makeVerifier().verify(makeToken({ iss: "https://evil.example.com" }))).toBeNull();
  });

  test("token หมดอายุไม่ผ่าน", async () => {
    expect(await makeVerifier().verify(makeToken({ exp: Math.floor(Date.now() / 1000) - 10 }))).toBeNull();
  });

  test("kid ที่ไม่รู้จักไม่ผ่าน", async () => {
    expect(await makeVerifier().verify(makeToken({}, { kid: "unknown-key" }))).toBeNull();
  });

  test("ข้อมูลที่ไม่ใช่ JWT ไม่ทำให้ระเบิด", async () => {
    const verifier = makeVerifier();
    expect(await verifier.verify("ไม่ใช่ token")).toBeNull();
    expect(await verifier.verify("")).toBeNull();
    expect(await verifier.verify(null)).toBeNull();
    expect(await verifier.verify("a.b.c")).toBeNull();
  });

  test("ไม่ได้ตั้ง client id = ปิดการล็อกอินด้วย Google", async () => {
    const verifier = new GoogleVerifier({ clientIds: [] });
    expect(verifier.enabled).toBe(false);
    expect(await verifier.verify(makeToken())).toBeNull();
  });

  test("แคชกุญแจไว้ ไม่ยิงไปโหลดใหม่ทุกครั้ง", async () => {
    const verifier = makeVerifier();
    await verifier.verify(makeToken());
    await verifier.verify(makeToken());
    await verifier.verify(makeToken());
    expect(fetchCount).toBe(1);
  });
});
