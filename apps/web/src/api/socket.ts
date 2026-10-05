/**
 * การเชื่อมต่อกับเซิร์ฟเวอร์
 *
 * ต่อใหม่เองเมื่อหลุด และส่งโทเคนเดิมกลับไปเสมอ ไม่งั้นจะกลายเป็นคนใหม่ทุกครั้ง
 * และกลับเข้าเกมที่ค้างอยู่ไม่ได้
 */

import { PROTOCOL_VERSION, type ServerMessage } from "./types";

const TOKEN_KEY = "makthai.token";
const NAME_KEY = "makthai.name";

/** เริ่มหน่วงเท่าไร แล้วคูณสองทุกครั้งที่ล้มเหลว */
const BASE_RETRY_DELAY = 500;
const MAX_RETRY_DELAY = 8000;
/** คำสั่งที่ค้างรอนานเกินนี้ต้องทิ้ง

  คำสั่งที่ค้างคือคำสั่งที่ผู้เล่นทำไปแล้วแต่ส่งไม่ถึง เช่น เดินหมากที่ตอนนั้นกำลังอยู่ในเกม
  ถ้านำไปส่งหลังต่อใหม่ เกมอาจเปลี่ยนไปแล้ว คำสั่งก็ไปตกในเกมอื่นหรือทำให้ผิดกติกา
  การทิ้งปล่อยให้เซิร์ฟเวอร์ส่งสถานะจริงกลับมาแสดงแทน ซึ่งถูกต้องกว่า
 */
const PENDING_TTL_MS = 10_000;

/** เวลาปัจจุบันแบบเดียวทั้งไฟล์ เทสต์จะแทนที่เพื่อควบคุมเอง */
export function now(): number {
  return Date.now();
}

export type Listener = (message: ServerMessage) => void;

function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export class GameSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retryDelay = BASE_RETRY_DELAY;
  private closed = false;
  /** คำสั่งที่ส่งตอนสายยังไม่พร้อม เก็บไว้ส่งหลังต่อติด พร้อมเวลาที่ทำ เพื่อทิ้งถ้าเก่าเกินไป */
  private pending: { message: unknown; at: number }[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    if (this.socket || this.closed) return;
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    // ใช้ onX ไม่ใช่ addEventListener เพราะต้องถอดออกได้ตอนปิด
    socket.onopen = () => {
      this.retryDelay = BASE_RETRY_DELAY;
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token: localStorage.getItem(TOKEN_KEY) ?? undefined,
        name: localStorage.getItem(NAME_KEY) ?? undefined,
      });
      // ส่งเฉพาะคำสั่งที่ยังไม่เก่าพอ คำสั่งที่ทำไปนานแล้วอาจไม่เกี่ยวกับเกมปัจจุบัน
      const fresh = this.pending.filter((entry) => now() - entry.at < PENDING_TTL_MS);
      this.pending = [];
      fresh.forEach((entry) => this.send(entry.message));
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (message.type === "session") {
        localStorage.setItem(TOKEN_KEY, message.token);
        localStorage.setItem(NAME_KEY, message.name);
      }
      this.listeners.forEach((listener) => listener(message));
    };

    socket.onclose = () => {
      // ต้องเช็คว่าปิดตัวนี้เพราะถูกตั้งใจ ก่อนแตะ this.socket
      // ถ้าไม่เช็ค close ของตัวเก่าจะเขียนทับตัวใหม่เป็น null
      // ทำให้ตัวใหม่ยังส่งข้อความได้แต่ไม่มีใครรู้จักอีกต่อไป
      if (this.socket !== socket) return;
      this.socket = null;
      this.pending = [];
      if (this.closed) return;
      this.retryTimer = setTimeout(() => this.connect(), this.nextDelay());
    };
  }

  /** หน่วงก่อนต่อใหม่ โดยเติมความผันผวนเล็กน้อยเพื่อไม่ให้หลายแท็บต่อพร้อมกัน

    ไม่มี jitter แล้ว client ที่หลุดพร้อมกันจะต่อใหม่พร้อมกันทุกครั้ง
    ทำให้เซิร์ฟเวอร์ที่เพิ่งฟื้นต้องรับการเชื่อมต่อเป็นวงกว้าง
    */
  private nextDelay(): number {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
    // สุ่มในช่วงครึ่งหนึ่งถึงเต็ม เพื่อให้ไม่มีใครชนกันพร้อมกันเป๊ะ
    return Math.round(delay * (0.5 + Math.random() * 0.5));
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    // ทิ้งของเก่าก่อนเพิ่มใหม่ ไม่งั้นคิวจะโตไม่จำกัดถ้าเชื่อมต่อไม่ขึ้นสักที
    const cutoff = now() - PENDING_TTL_MS;
    if (this.pending.length === 0 || this.pending[0].at > cutoff) {
      this.pending.push({ message, at: now() });
    }
  }

  /** ส่งการเล่นหนึ่งครั้ง — เกมเป็นคนตัดสินว่าถูกกติกาไหม */
  act(action: string, payload: Record<string, unknown> = {}): void {
    this.send({ type: "action", action, payload });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.discardSocket();
  }

  /** ปิดการเชื่อมต่อปัจจุบันโดยไม่ให้มันต่อใหม่และไม่ทำให้คิวค้างปน

    ต้องตัด listener ออกก่อนปิดเสมอ มิฉะนั้น close จะยิงตัวจับเวลาต่อใหม่
    และเขียน this.socket เป็น null ทับตัวที่เพิ่งเปิดใหม่
    */
  private discardSocket(): void {
    this.stopRetry();
    this.pending = [];
    const socket = this.socket;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    this.socket = null;
  }

  /** ต่อใหม่ทันที ใช้หลังล็อกอินหรือออกจากระบบ เพื่อผูกตัวตนใหม่ */
  reconnect(): void {
    this.discardSocket();
    this.closed = false;
    this.retryDelay = BASE_RETRY_DELAY;
    this.connect();
  }

  /** ยกเลิกตัวจับเวลารอต่อใหม่ ต้องทำทุกครั้งก่อนเปิดการเชื่อมต่อใหม่เอง */
  private stopRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** ใช้โทเคนของบัญชีเป็นตัวตนหลัก แทนโทเคนผู้เล่นชั่วคราว */
  static rememberToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  }

  static clearIdentity(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  }

  static rememberName(name: string): void {
    localStorage.setItem(NAME_KEY, name);
  }
}
