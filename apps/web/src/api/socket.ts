/**
 * การเชื่อมต่อกับเซิร์ฟเวอร์
 *
 * ต่อใหม่เองเมื่อหลุด และส่งโทเคนเดิมกลับไปเสมอ ไม่งั้นจะกลายเป็นคนใหม่ทุกครั้ง
 * และกลับเข้าเกมที่ค้างอยู่ไม่ได้
 */

import { PROTOCOL_VERSION, type ServerMessage } from "./types";

const TOKEN_KEY = "makthai.token";
const NAME_KEY = "makthai.name";

export type Listener = (message: ServerMessage) => void;

function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export class GameSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retryDelay = 500;
  private closed = false;
  /** คำสั่งที่ส่งตอนสายยังไม่พร้อม เก็บไว้ส่งหลังต่อติด */
  private pending: unknown[] = [];

  connect(): void {
    if (this.socket || this.closed) return;
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryDelay = 500;
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token: localStorage.getItem(TOKEN_KEY) ?? undefined,
        name: localStorage.getItem(NAME_KEY) ?? undefined,
      });
      const queued = this.pending;
      this.pending = [];
      queued.forEach((message) => this.send(message));
    });

    socket.addEventListener("message", (event) => {
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
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 8000);
    });
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.pending.push(message);
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
    this.socket?.close();
    this.socket = null;
  }

  static clearIdentity(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  }

  static rememberName(name: string): void {
    localStorage.setItem(NAME_KEY, name);
  }
}
