/**
 * การต่อใหม่หลังหลุด
 *
 * สิ่งที่พังง่ายที่สุดคือการต่อใหม่ซ้ำจนมี socket เก่าค้างอยู่ แล้วเมื่อเก่าปิดทีหลัง
 * มันจะไปเขียนทับตัวใหม่จนตัวใหม่ส่งข้อความไม่ออก เทสต์นี้จับกรณีนั้นไว้
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GameSocket } from "./socket";

/** socket ปลอมที่เทสต์คุมได้เอง ปลอมทั้งการเปิด การปิด และการรับข้อความ */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;

  static created: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor() {
    FakeSocket.created.push(this);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** ปิดถูกต้องเหมือนเบราว์เซอร์: ยิง onclose เสมอ แม้ listener ถูกถอดไปแล้วก็เงียบ */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  parsed(): { type: string }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }
}

function lastSocket(): FakeSocket {
  const socket = FakeSocket.created.at(-1);
  if (!socket) throw new Error("ยังไม่มีการสร้าง socket");
  return socket;
}

beforeEach(() => {
  FakeSocket.created = [];
  vi.useFakeTimers();
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

describe("GameSocket", () => {
  it("ส่ง hello เมื่อเปิดการเชื่อมต่อ", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    expect(lastSocket().parsed()[0].type).toBe("hello");
  });

  it("ต่อใหม่เองเมื่อหลุด", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    lastSocket().drop();
    vi.advanceTimersByTime(10_000);

    expect(FakeSocket.created).toHaveLength(2);
  });

  it("ไม่ต่อใหม่เมื่อปิดเอง", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    socket.close();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.created).toHaveLength(1);
  });

  it("socket เก่าที่ปิดทีหลังต้องไม่เขียนทับตัวใหม่", () => {
    // กรณีนี้ทำให้ตัวใหม่หายไปจากการติดตามของ GameSocket
    // ข้อความจะส่งได้ตอนเปิด แต่หลังหลุดอีกครั้งจะไม่มีการต่อใหม่เกิดขึ้น
    const socket = new GameSocket();
    socket.connect();
    const first = lastSocket();
    first.open();

    socket.reconnect();
    const second = lastSocket();
    second.open();

    // socket แรกหลุดหลังจากที่เปิดตัวที่สองไปแล้ว — ต้องไม่กระทบ
    first.drop();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.created).toHaveLength(2);
    // ตัวที่สองยังเป็นตัวที่ GameSocket จับถืออยู่
    second.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.created).toHaveLength(3);
  });

  it("ต่อใหม่แล้วตัวใหม่ยังใช้งานได้", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();
    socket.reconnect();
    lastSocket().open();

    const before = lastSocket().sent.length;
    socket.act("select", { square: 5 });
    expect(lastSocket().sent.length).toBe(before + 1);
    expect(lastSocket().parsed().at(-1)?.type).toBe("action");
  });

  it("หน่วงถอยหลังเมื่อล้มเหลวซ้ำ", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    lastSocket().drop();
    // รอบแรกยังไม่ถึงเวลาของรอบถัดไป
    vi.advanceTimersByTime(100);
    expect(FakeSocket.created).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.created).toHaveLength(2);

    lastSocket().drop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.created).toHaveLength(3);
  });

  it("เพิ่มความผันผวนให้การต่อใหม่ ไม่ให้ต่อพร้อมกันเป๊ะ", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    // บังคับให้สุ่มได้ค่าเดิมทุกครั้ง ถ้ายังมีการสุ่มอยู่จะเห็นว่าถูกเรียก
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSocket().drop();
      vi.advanceTimersByTime(60_000);
    }

    expect(random).toHaveBeenCalled();
    random.mockRestore();
  });

  it("เก็บคำสั่งที่ส่งไม่ถึงไว้ส่งหลังต่อใหม่", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    // สั่งตอนที่ยังต่ออยู่ = ส่งออกไปเลย ไม่ตกคิว
    socket.act("select", { square: 3 });
    expect(lastSocket().parsed().filter((m) => m.type === "action")).toHaveLength(1);

    lastSocket().drop();
    // หลุดแล้วสั่ง — ตกคิวเพราะไม่มีทางส่ง
    socket.act("select", { square: 4 });

    // ต่อใหม่ได้เร็ว ก่อนคำสั่งจะเก่าจนถูกทิ้ง
    vi.advanceTimersByTime(1_000);
    lastSocket().open();

    expect(lastSocket().parsed().filter((m) => m.type === "action")).toHaveLength(1);
  });

  it("ทิ้งคำสั่งที่ค้างนานเกินไป ไม่ส่งซ้ำในเกมใหม่", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();

    lastSocket().drop();
    socket.act("play", { to: 12 });

    // เลยเวลาที่ยอมรับแล้ว
    vi.advanceTimersByTime(60_000);
    lastSocket().open();

    expect(lastSocket().parsed().filter((m) => m.type === "action")).toHaveLength(0);
  });

  it("คิวคำสั่งไม่สะสมเป็นอนันต์เมื่อส่งไม่ได้นาน", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();
    lastSocket().drop();

    // สั่งทีละน้อยเพื่อให้สุ่มเวลาเดินหน้าจริงแต่ละครั้ง
    for (let i = 0; i < 20; i += 1) {
      socket.act("select", { square: i });
      vi.advanceTimersByTime(5_000);
    }
    vi.advanceTimersByTime(60_000);
    lastSocket().open();

    // คำสั่งที่เก่ากว่า 10 วินาทีถูกทิ้งหมด
    expect(lastSocket().parsed().filter((m) => m.type === "action")).toHaveLength(0);
  });

  it("จำโทเคนที่เซิร์ฟเวอร์ส่งมา", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();
    lastSocket().deliver({ type: "session", token: "tok-1", name: "Fox" });

    expect(localStorage.getItem("makthai.token")).toBe("tok-1");
    expect(localStorage.getItem("makthai.name")).toBe("Fox");
  });

  it("ยังเปิดต่อได้หลังเรียก close แล้วผ่าน reconnect", () => {
    const socket = new GameSocket();
    socket.connect();
    lastSocket().open();
    socket.close();

    socket.reconnect();
    lastSocket().open();

    expect(FakeSocket.created).toHaveLength(2);
    expect(lastSocket().readyState).toBe(FakeSocket.OPEN);
  });
});
