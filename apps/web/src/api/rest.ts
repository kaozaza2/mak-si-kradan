/**
 * เรียก REST พร้อมแนบโทเคน
 *
 * เซิร์ฟเวอร์ตอบเป็นรหัสเสมอเมื่อผิดพลาด จึงโยนข้อผิดพลาดที่พกรหัสไปด้วย
 * ให้ผู้เรียกแปลเองตามภาษาที่ผู้ใช้เลือก
 */

const AUTH_KEY = "makthai.auth";

export interface AccountUser {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  verified: boolean;
  /** ผูกกับบัญชี Google แล้ว — ตั้งรหัสผ่านเองอาจยังไม่มี */
  google?: boolean;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface AuthResponse {
  token: string;
  user: AccountUser;
  /** สมัครด้วยอีเมลใหม่ ยังต้องกรอกรหัสหกหลักก่อนถึงจะนับอันดับ */
  verificationRequired?: boolean;
}

export interface FriendSummary {
  id: string;
  name: string;
  username: string | null;
  rating: number;
  online?: boolean;
}

export interface FriendListing {
  friends: FriendSummary[];
  incoming: { requestId: number; player: FriendSummary }[];
  outgoing: { requestId: number; player: FriendSummary }[];
}

export class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const authToken = (): string | null => localStorage.getItem(AUTH_KEY);
export const setAuthToken = (token: string): void => localStorage.setItem(AUTH_KEY, token);
export const clearAuthToken = (): void => localStorage.removeItem(AUTH_KEY);

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(String(body.code ?? `http_${response.status}`));
  return body as T;
}

export const post = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
