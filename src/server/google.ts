/**
 * ตรวจ Google ID token
 *
 * ใช้รูปแบบที่ client ฝั่งไหนก็ทำได้เหมือนกัน — เว็บ, iOS, Android ต่างขอ ID token
 * จาก Google SDK ของตัวเอง แล้วส่งมาให้ server ตรวจ ไม่ต้องมี redirect flow
 * ซึ่งจำเป็นสำหรับ crossplay เพราะแอปมือถือทำ redirect แบบเว็บไม่ได้สะดวก
 *
 * ตรวจลายเซ็นเองด้วยกุญแจสาธารณะของ Google แทนที่จะเรียก tokeninfo ทุกครั้ง
 * จะได้ไม่ต้องยิงออกนอกทุกการล็อกอิน
 */

import { createPublicKey, createVerify } from "node:crypto";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface GoogleVerifierOptions {
  /** client id ที่ยอมรับ — ปกติมีหลายตัวเพราะเว็บกับมือถือใช้คนละตัว */
  clientIds: string[];
  jwksUrl?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export class GoogleVerifier {
  private readonly clientIds: Set<string>;
  private readonly jwksUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cache: { keys: Map<string, Jwk>; expiresAt: number } | null = null;

  constructor(options: GoogleVerifierOptions) {
    this.clientIds = new Set(options.clientIds.filter(Boolean));
    this.jwksUrl = options.jwksUrl ?? GOOGLE_JWKS_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.clientIds.size > 0;
  }

  /** คืน identity เมื่อ token ถูกต้องทุกประการ ไม่งั้นคืน null */
  async verify(idToken: unknown): Promise<GoogleIdentity | null> {
    if (!this.enabled || typeof idToken !== "string") return null;

    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature] = parts;

    let header: { kid?: string; alg?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(rawHeader, "base64url").toString());
      payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString());
    } catch {
      return null;
    }

    // รับเฉพาะ RS256 — ป้องกัน alg confusion เช่นการยัด alg:none เข้ามา
    if (header.alg !== "RS256" || !header.kid) return null;

    const jwk = await this.findKey(header.kid);
    if (!jwk) return null;

    let verified = false;
    try {
      const key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
      verified = createVerify("RSA-SHA256")
        .update(`${rawHeader}.${rawPayload}`)
        .verify(key, Buffer.from(rawSignature, "base64url"));
    } catch {
      return null;
    }
    if (!verified) return null;

    if (typeof payload.iss !== "string" || !VALID_ISSUERS.has(payload.iss)) return null;
    if (typeof payload.aud !== "string" || !this.clientIds.has(payload.aud)) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    // เผื่อนาฬิกาคลาดกันเล็กน้อยระหว่างเครื่อง
    if (typeof payload.iat === "number" && payload.iat > nowSeconds + 300) return null;

    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
      emailVerified: payload.email_verified === true || payload.email_verified === "true",
      name: typeof payload.name === "string" ? payload.name : null,
    };
  }

  private async findKey(kid: string): Promise<Jwk | null> {
    const cached = this.cache;
    if (cached && cached.expiresAt > this.now()) {
      const key = cached.keys.get(kid);
      if (key) return key;
    }
    // ไม่รู้จัก kid นี้ อาจเพราะ Google หมุนกุญแจ ลองโหลดใหม่หนึ่งครั้ง
    await this.refresh();
    return this.cache?.keys.get(kid) ?? null;
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.fetcher(this.jwksUrl);
      if (!response.ok) return;
      const body = (await response.json()) as { keys?: Jwk[] };
      const keys = new Map<string, Jwk>();
      for (const key of body.keys ?? []) {
        if (key.kty === "RSA" && key.kid) keys.set(key.kid, key);
      }
      if (keys.size > 0) this.cache = { keys, expiresAt: this.now() + JWKS_TTL_MS };
    } catch {
      // โหลดกุญแจไม่ได้ก็ปล่อยให้ verify คืน null ดีกว่าปล่อยผ่าน
    }
  }
}
