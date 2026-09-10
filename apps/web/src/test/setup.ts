import "@testing-library/jest-dom/vitest";

// ตรึงภาษาไว้ ไม่งั้นผลเทสต์ขึ้นกับภาษาของเครื่องที่รัน
localStorage.setItem("makthai.locale", "th");

/**
 * WebSocket ปลอมที่ไม่ทำอะไรเลย
 *
 * เทสต์ไม่ควรเปิดการเชื่อมต่อจริง ตัวจริงจะพยายามต่อออกไปข้างนอกแล้วโยน
 * ข้อผิดพลาดหลังเทสต์จบไปแล้ว ซึ่งไล่หาต้นตอยากมาก
 */
class SilentWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SilentWebSocket.CONNECTING;
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  send(): void {}
  close(): void {
    this.readyState = SilentWebSocket.CLOSED;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
