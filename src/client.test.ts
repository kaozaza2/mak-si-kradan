/**
 * Smoke test ของหน้าเว็บ: โหลด index.html + app.js จริงใน DOM จำลอง
 * แล้วป้อน state ที่ออกมาจาก engine/สร้างโดย MatchRoom เหมือนที่ server ส่งจริง
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { MatchRoom } from "./server/match.js";
import type { PublicPlayer, ServerMessage } from "./server/protocol.js";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
const script = await Bun.file(new URL("../public/app.js", import.meta.url)).text();

const PLAYERS: PublicPlayer[] = [
  { id: "guest_aaa", name: "อาทิตย์", connected: true },
  { id: "guest_bbb", name: "บุญมี", connected: true },
];

interface Harness {
  window: any;
  document: any;
  sent: any[];
  deliver(message: ServerMessage): void;
  close(): Promise<void>;
}

async function mount(options: { seenHelp?: boolean } = {}): Promise<Harness> {
  const window = new Window({ url: "http://localhost:3000/" });
  const sent: any[] = [];
  let socket: any = null;

  (window as any).WebSocket = class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    listeners: Record<string, ((event: any) => void)[]> = {};
    constructor() {
      socket = this;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, handler: (event: any) => void) {
      (this.listeners[type] ??= []).push(handler);
    }
    emit(type: string, event: any) {
      for (const handler of this.listeners[type] ?? []) handler(event);
    }
    send(raw: string) {
      sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
    }
  } as never;

  // ค่าเริ่มต้นของเทสต์คือ "เคยเห็นวิธีเล่นแล้ว" เพื่อไม่ให้ modal บังเทสต์อื่น
  if (options.seenHelp !== false) window.localStorage.setItem("msk.seenHelp", "1");

  window.document.write(html);
  window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 10));

  return {
    window,
    document: window.document,
    sent,
    deliver(message) {
      socket.emit("message", { data: JSON.stringify(message) });
    },
    async close() {
      await window.happyDOM.close();
    },
  };
}

function startedMatch(): { match: MatchRoom; messages: ServerMessage[] } {
  const match = new MatchRoom("match_1", [PLAYERS[0].id, PLAYERS[1].id], 0, () => {});
  return {
    match,
    messages: [
      { type: "session", id: PLAYERS[0].id, token: "tok", name: "อาทิตย์", kind: "guest" },
      { type: "match_start", matchId: match.id, you: 0, players: PLAYERS, turnSeconds: 0, nodeUrl: "" },
      { type: "state", state: match.stateView(PLAYERS) },
    ],
  };
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("หน้าเว็บ", () => {
  test("โหลดแล้วสร้างกระดาน 64 ช่อง และเปิด session ทันที", async () => {
    harness = await mount();
    expect(harness.document.querySelectorAll(".cell").length).toBe(64);
    expect(harness.document.querySelectorAll(".cell.center").length).toBe(4);
    expect(harness.sent[0].type).toBe("hello");
    expect(harness.document.getElementById("screen-lobby").classList.contains("hidden")).toBe(false);
  });

  test("เข้าเกมแล้ววาดหมาก 60 ตัว พร้อมชื่อและคะแนน", async () => {
    harness = await mount();
    const { messages } = startedMatch();
    for (const message of messages) harness.deliver(message);

    expect(harness.document.getElementById("screen-game").classList.contains("hidden")).toBe(false);
    expect(harness.document.querySelectorAll(".cell .piece").length).toBe(60);
    const seats = harness.document.querySelectorAll("#score-list .side");
    expect(seats.length).toBe(2);
    expect(seats[0].textContent).toContain("อาทิตย์");
    expect(seats[0].textContent).toContain("(คุณ)");
    expect(seats[0].classList.contains("active")).toBe(true);
    expect(harness.document.getElementById("turn-no").textContent).toBe("Turn 1");
    expect(harness.document.getElementById("game-status").textContent).toContain("ตาคุณ");
    // เทิร์นแรกเลือกได้ 32 ตัว
    expect(harness.document.querySelectorAll(".cell.selectable").length).toBe(32);
  });

  test("คลิกหมากแล้วส่งคำสั่ง select ไปให้ server ตัดสิน", async () => {
    harness = await mount();
    const { match, messages } = startedMatch();
    for (const message of messages) harness.deliver(message);
    harness.sent.length = 0;

    const target = match.game.selectable()[0];
    harness.document.querySelector(`.cell[data-square="${target}"]`).click();
    expect(harness.sent).toEqual([{ type: "select", square: target }]);
  });

  test("เมื่อ server ตอบกลับพร้อม targets จะไฮไลต์ช่องลงและคลิกแล้วส่ง capture", async () => {
    harness = await mount();
    const { match, messages } = startedMatch();
    for (const message of messages) harness.deliver(message);

    // เลือกหมากที่กินได้จริงบน engine ฝั่ง server
    const capturer = match.game.selectable().find((square) => {
      const probe = new MatchRoom("probe", [PLAYERS[0].id, PLAYERS[1].id], 0, () => {});
      probe.game.select(square);
      return probe.game.state.selection?.kind === "capture";
    })!;
    match.game.select(capturer);
    harness.deliver({ type: "state", state: match.stateView(PLAYERS) });

    const targets = harness.document.querySelectorAll(".cell.target.capture");
    expect(targets.length).toBeGreaterThan(0);
    expect(harness.document.querySelectorAll(".cell.selected").length).toBe(1);
    // แถบ chain ขึ้นเมื่อเริ่มกินจริงแล้วเท่านั้น ไม่ใช่แค่หยิบหมาก
    expect(harness.document.getElementById("chain-bar").classList.contains("hidden")).toBe(true);

    harness.sent.length = 0;
    const landing = Number(targets[0].dataset.square);
    targets[0].click();
    expect(harness.sent[0]).toEqual({ type: "capture", to: landing });

    // บนกระดานเปิดเกม chain ยาวสุดคือ 1 เทิร์นจึงจบทันทีที่กิน แถบ chain ไม่ต้องขึ้น
    match.game.captureTo(landing);
    harness.deliver({ type: "state", state: match.stateView(PLAYERS) });
    expect(harness.document.getElementById("chain-bar").classList.contains("hidden")).toBe(true);
    expect(harness.document.querySelectorAll("#score-list .side")[0].textContent).toContain("1");
    expect(harness.document.querySelectorAll(".cell .piece").length).toBe(59);
  });

  test("คลิกช่องที่เล่นไม่ได้ ไม่ส่งอะไรออกไป", async () => {
    harness = await mount();
    const { messages } = startedMatch();
    for (const message of messages) harness.deliver(message);
    harness.sent.length = 0;

    harness.document.querySelector('.cell[data-square="27"]').click(); // ช่องกลางที่ว่าง
    expect(harness.sent.length).toBe(0);
  });

  test("ตาคู่แข่งจะกดอะไรบนกระดานไม่ได้", async () => {
    harness = await mount();
    const match = new MatchRoom("m", [PLAYERS[0].id, PLAYERS[1].id], 0, () => {});
    harness.deliver({ type: "session", id: PLAYERS[1].id, token: "t", name: "บุญมี", kind: "guest" });
    harness.deliver({ type: "match_start", matchId: match.id, you: 1, players: PLAYERS, turnSeconds: 0, nodeUrl: "" });
    harness.deliver({ type: "state", state: match.stateView(PLAYERS) });

    expect(harness.document.getElementById("game-status").textContent).toContain("รอ อาทิตย์");
    expect(harness.document.querySelectorAll(".cell.selectable").length).toBe(0);
    harness.sent.length = 0;
    harness.document.querySelector(`.cell[data-square="${match.game.selectable()[0]}"]`).click();
    expect(harness.sent.length).toBe(0);
  });

  test("ห้องส่วนตัวแสดงรหัสและลิงก์เชิญ", async () => {
    harness = await mount();
    harness.deliver({
      type: "room",
      room: {
        id: "r1",
        code: "K4D8Q2",
        hostId: PLAYERS[0].id,
        status: "ready",
        visibility: "private",
        mode: "assisted",
        capacity: 2,
        turnSeconds: 45,
        players: PLAYERS,
        inviteUrl: "http://localhost:3000/join/K4D8Q2",
      },
    });
    expect(harness.document.getElementById("room-code").textContent).toBe("K4D8Q2");
    expect(harness.document.getElementById("room-players").textContent).toContain("อาทิตย์");
    expect(harness.document.getElementById("screen-room").classList.contains("hidden")).toBe(false);
  });

  test("หน้าสรุปผลแสดงคะแนน เหตุผล และสถิติ", async () => {
    harness = await mount();
    const { match, messages } = startedMatch();
    for (const message of messages) harness.deliver(message);

    match.game.state.scores = [27, 23];
    match.game.endGame("agreement");
    harness.deliver({
      type: "match_end",
      matchId: match.id,
      result: match.game.state.result!,
      stats: match.game.stats(),
      history: match.game.state.history,
      players: PLAYERS,
    });

    expect(harness.document.getElementById("screen-result").classList.contains("hidden")).toBe(false);
    expect(harness.document.getElementById("result-title").textContent).toContain("คุณชนะ");
    expect(harness.document.getElementById("result-scores").textContent).toContain("27");
    expect(harness.document.getElementById("result-reason").textContent).toContain("ตกลงจบเกม");
    expect(harness.document.getElementById("result-stats").textContent).toContain("Chain สูงสุด");
  });

  test("คำท้าที่เข้ามาแสดง modal และตอบรับได้", async () => {
    harness = await mount();
    harness.deliver({ type: "challenge_in", id: "c1", from: PLAYERS[1] });
    expect(harness.document.getElementById("challenge-modal").classList.contains("hidden")).toBe(false);
    expect(harness.document.getElementById("challenge-text").textContent).toContain("บุญมี");

    harness.sent.length = 0;
    harness.document.getElementById("btn-accept-challenge").click();
    expect(harness.sent).toEqual([{ type: "challenge_respond", challengeId: "c1", accept: true }]);
  });

  test("แผ่นวิธีเล่นเปิดเองครั้งแรกที่เข้ามา แล้วไม่เปิดซ้ำอีก", async () => {
    harness = await mount({ seenHelp: false });
    expect(harness.document.getElementById("help-modal").classList.contains("hidden")).toBe(false);
    expect(harness.window.localStorage.getItem("msk.seenHelp")).toBe("1");
    await harness.close();

    harness = await mount();
    expect(harness.document.getElementById("help-modal").classList.contains("hidden")).toBe(true);
  });

  test("กดปุ่มวิธีเล่นแล้วเปิด ปิดด้วย Esc ได้", async () => {
    harness = await mount();
    const modal = harness.document.getElementById("help-modal");

    harness.document.querySelector("[data-help]").click();
    expect(modal.classList.contains("hidden")).toBe(false);

    const escape = new harness.window.KeyboardEvent("keydown", { key: "Escape" });
    harness.document.dispatchEvent(escape);
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  test("แผนภาพถูกวาดจริง ไม่ใช่ช่องเปล่า", async () => {
    harness = await mount();
    const directions = harness.document.querySelector('[data-mini="directions"]');
    expect(directions.querySelectorAll(".mc").length).toBe(25);
    // หมากที่กำลังเล่น 1 ตัว ล้อมด้วยหมากอีก 8 ตัว และมีช่องลงได้ 8 ช่อง
    expect(directions.querySelectorAll(".mc.actor").length).toBe(1);
    expect(directions.querySelectorAll(".mc .piece").length).toBe(9);
    expect(directions.querySelectorAll(".mc.spot").length).toBe(8);

    const before = harness.document.querySelector('[data-mini="capture-before"]');
    expect(before.querySelectorAll(".mc.prey").length).toBe(1);
    expect(before.querySelectorAll(".mc.spot").length).toBe(1);
  });

  test("เปิดวิธีเล่นระหว่างเล่น จะชี้ว่าห้องนี้ใช้โหมดไหน", async () => {
    harness = await mount();
    const { messages } = startedMatch();
    for (const message of messages) harness.deliver(message);

    harness.document.querySelector("#screen-game [data-help]").click();
    const current = harness.document.querySelectorAll("#help-modes tr.current");
    expect(current.length).toBe(1);
    expect(current[0].dataset.mode).toBe("assisted");
  });

  test("กระดานกำหนดทั้งแถวและคอลัมน์ ไม่งั้นช่องว่างจะสูงไม่เท่าช่องที่มีหมาก", () => {
    const board = css.slice(css.indexOf(".board {"), css.indexOf(".cell {"));
    expect(board).toContain("grid-template-columns: repeat(8, 1fr)");
    expect(board).toContain("grid-template-rows: repeat(8, 1fr)");
    expect(board).toContain("aspect-ratio: 1");
    // ต้องคิดความสูงจอด้วย ไม่ใช่กว้างอย่างเดียว ไม่งั้นจอเตี้ยกระดานจะล้น
    expect(board).toContain("100svh");
  });

  test("ช่องกระดานไม่โดนสไตล์ปุ่มทั่วไปเล่นงาน", () => {
    // ช่องเป็น <button> ถ้าไม่กันไว้ ทุกช่องจะเปลี่ยนสีตอน hover และกระดานจะขยับตอนกด
    expect(css).toContain(".cell:hover:not(:disabled)");
    expect(css).toContain(".cell:active:not(:disabled) { transform: none; }");
  });

  test("ที่ว่างถูกจองไว้ให้แถบ chain และข้อความสถานะ กันกระดานกระโดด", async () => {
    harness = await mount();
    const slot = harness.document.querySelector(".chain-slot");
    expect(slot).not.toBeNull();
    // แถบ chain ซ่อนอยู่ แต่กล่องที่ครอบมันยังกินที่เท่าเดิม
    expect(slot.querySelector("#chain-bar").classList.contains("hidden")).toBe(true);
    expect(css).toContain(".chain-slot { min-height: 46px");
    expect(css).toContain(".status { text-align: center; margin: 0; min-height: 2.8em");
  });

  test("ตารางสรุปผลกว้างคงที่และเลื่อนในกล่องตัวเองได้", async () => {
    harness = await mount();
    const table = harness.document.getElementById("result-stats");
    expect(table.parentElement.classList.contains("table-scroll")).toBe(true);
    expect(css).toContain("table-layout: fixed");
    expect(css).toContain(".table-scroll { width: 100%; overflow-x: auto; }");
  });

  test("ลิงก์เชิญ /join/CODE เข้าห้องให้อัตโนมัติหลังได้ session", async () => {
    const window = new Window({ url: "http://localhost:3000/join/K4D8Q2" });
    const sent: any[] = [];
    let socket: any = null;
    (window as any).WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, ((event: any) => void)[]> = {};
      constructor() {
        socket = this;
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(type: string, handler: (event: any) => void) {
        (this.listeners[type] ??= []).push(handler);
      }
      emit(type: string, event: any) {
        for (const handler of this.listeners[type] ?? []) handler(event);
      }
      send(raw: string) {
        sent.push(JSON.parse(raw));
      }
      close() {}
    } as never;
    window.document.write(html);
    window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 10));

    socket.emit("message", {
      data: JSON.stringify({ type: "session", id: "guest_x", token: "t", name: "Guest Fox", kind: "guest" }),
    });
    expect(sent).toContainEqual({ type: "join_room", code: "K4D8Q2" });
    await window.happyDOM.close();
  });
});
