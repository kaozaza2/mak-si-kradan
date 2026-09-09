import { afterEach, describe, expect, test } from "bun:test";
import { Hub, type Connection } from "./hub.js";
import type { ServerMessage } from "./protocol.js";

let seq = 0;

class FakeConnection implements Connection {
  readonly id = `test_conn_${++seq}`;
  sessionId: string | null = null;
  messages: ServerMessage[] = [];
  closed = false;

  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  close(): void {
    this.closed = true;
  }

  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === type) return this.messages[i] as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
  all<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
  clear(): void {
    this.messages = [];
  }
}

/** เดินแทนคนจริงหนึ่งเทิร์นเต็ม โดยอาศัย targets ที่ server ส่งมาเท่านั้น */
function playHumanTurn(hub: Hub, conn: FakeConnection): void {
  let state = conn.last("state")!.state;
  for (const square of state.selectable) {
    hub.handleMessage(conn, { type: "select", square });
    state = conn.last("state")!.state;
    if (state.targetKind === "capture") break;
  }
  while (state.status === "active" && state.selection) {
    if (state.targets.length === 0) break;
    const kind = state.targetKind === "capture" ? "capture" : "move";
    hub.handleMessage(conn, { type: kind, to: state.targets[0] } as never);
    state = conn.last("state")!.state;
  }
}

/** ที่นั่งของ connection นี้ในแมตช์ปัจจุบัน (ลำดับถูกสุ่ม จึงต้องถามเอา) */
function seatOf(conn: FakeConnection): number {
  return conn.last("match_start")!.you;
}

const hubs: Hub[] = [];

function newHub(): Hub {
  // turnSeconds = 0 คือไม่จับเวลา ทำให้เทสต์ไม่ค้างเพราะ timer
  const hub = new Hub({ defaultTurnSeconds: 0, baseUrl: "http://test.local" });
  hubs.push(hub);
  return hub;
}

function connect(hub: Hub, name?: string, token?: string): FakeConnection {
  const conn = new FakeConnection();
  hub.handleMessage(conn, { type: "hello", name, token });
  return conn;
}

afterEach(() => {
  while (hubs.length) hubs.pop()!.dispose();
});

describe("Guest session", () => {
  test("เล่นได้ทันทีโดยไม่ต้องสมัคร และได้ id/ชื่อชั่วคราว", () => {
    const hub = newHub();
    const conn = connect(hub);
    const session = conn.last("session")!;
    expect(session.kind).toBe("guest");
    expect(session.id).toMatch(/^guest_[0-9a-f]{6}$/);
    expect(session.name).toMatch(/^Guest /);
    expect(session.token.length).toBeGreaterThan(10);
  });

  test("ตั้งชื่อเองได้", () => {
    const hub = newHub();
    const conn = connect(hub, "เก้า");
    expect(conn.last("session")!.name).toBe("เก้า");
  });

  test("token เดิมได้ session เดิมกลับมา", () => {
    const hub = newHub();
    const first = connect(hub, "เก้า");
    const token = first.last("session")!.token;
    hub.handleClose(first);

    const second = connect(hub, undefined, token);
    expect(second.last("session")!.id).toBe(first.last("session")!.id);
    expect(second.last("session")!.name).toBe("เก้า");
  });
});

describe("Quick Match", () => {
  test("คนแรกเข้าคิว คนที่สองจับคู่ทันที", () => {
    const hub = newHub();
    const a = connect(hub, "A");
    const b = connect(hub, "B");

    hub.handleMessage(a, { type: "quick_match" });
    expect(a.last("queue")!.searching).toBe(true);
    expect(b.last("match_start")).toBeUndefined();

    hub.handleMessage(b, { type: "quick_match" });
    const startA = a.last("match_start")!;
    const startB = b.last("match_start")!;
    expect(startA.matchId).toBe(startB.matchId);
    expect(startA.you).not.toBe(startB.you);
    expect(a.last("state")!.state.board.filter((cell) => cell >= 0).length).toBe(60);
  });

  test("ยกเลิกคิวได้", () => {
    const hub = newHub();
    const a = connect(hub, "A");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(a, { type: "cancel_quick_match" });
    expect(a.last("queue")!.searching).toBe(false);
    expect(hub.stats.queue).toBe(0);
  });
});

describe("Private Room", () => {
  test("สร้างห้อง เข้าห้องด้วยรหัส แล้วเริ่มเกม", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");

    hub.handleMessage(host, { type: "create_room" });
    const room = host.last("room")!.room;
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(room.inviteUrl).toBe(`http://test.local/join/${room.code}`);
    expect(room.players.length).toBe(1);

    hub.handleMessage(guest, { type: "join_room", code: room.code.toLowerCase() });
    expect(guest.last("room")!.room.players.length).toBe(2);
    expect(host.last("room")!.room.status).toBe("ready");

    hub.handleMessage(host, { type: "start_room" });
    expect(host.last("match_start")!.matchId).toBe(guest.last("match_start")!.matchId);
  });

  test("รหัสผิดแจ้ง error", () => {
    const hub = newHub();
    const guest = connect(hub, "Guest");
    hub.handleMessage(guest, { type: "join_room", code: "ZZZZZZ" });
    expect(guest.last("error")!.code).toBe("room_not_found");
    expect(guest.last("error")!.params).toEqual({ code: "ZZZZZZ" });
  });

  test("เฉพาะเจ้าของห้องเท่านั้นที่เริ่มเกมได้ และต้องมีครบ 2 คน", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");
    hub.handleMessage(host, { type: "create_room" });
    hub.handleMessage(host, { type: "start_room" });
    expect(host.last("error")!.code).toBe("room_needs_players");

    const code = host.last("room")!.room.code;
    hub.handleMessage(guest, { type: "join_room", code });
    hub.handleMessage(guest, { type: "start_room" });
    expect(guest.last("error")!.code).toBe("not_room_host");
  });

  test("เจ้าของห้องออก = ห้องปิด", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");
    hub.handleMessage(host, { type: "create_room" });
    hub.handleMessage(guest, { type: "join_room", code: host.last("room")!.room.code });
    hub.handleMessage(host, { type: "leave_room" });
    expect(guest.last("room_closed")!.code).toBe("room_closed_host_left");
    expect(hub.stats.rooms).toBe(0);
  });
});

describe("AI Match", () => {
  function aiHub(): Hub {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 2 });
    hubs.push(hub);
    return hub;
  }

  test("เริ่มเกมกับบอทได้ทันที และบอทถูกทำเครื่องหมายไว้ในรายชื่อผู้เล่น", () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "normal" });

    const start = player.last("match_start")!;
    const bot = start.players.find((p) => p.id !== player.last("session")!.id)!;
    expect(bot.bot).toBe("normal");
    // ชื่อบอทเป็นกลางทางภาษา client ประกอบชื่อเต็มเองจากระดับ
    expect(bot.name).toBe("AI");
    expect(bot.connected).toBe(true);
    expect(player.last("state")!.state.board.filter((cell) => cell >= 0).length).toBe(60);
  });

  test("ระดับ AI ที่ไม่รู้จักถูกปฏิเสธ", () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "impossible" as never });
    expect(player.last("error")!.code).toBe("bad_ai_level");
    expect(hub.stats.matches).toBe(0);
  });

  test("บอทเดินเองจนถึงตาคนจริง", async () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "easy" });

    const you = player.last("match_start")!.you;
    if (player.last("state")!.state.current === you) playHumanTurn(hub, player);

    await Bun.sleep(150);
    const state = player.last("state")!.state;
    expect(state.current).toBe(you);
    expect(state.turn).toBeGreaterThan(1);
    expect(state.lastTurn).not.toBeNull();
  });

  test("บอทไม่โผล่ในรายชื่อผู้เล่นที่ท้าได้", () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    const other = connect(hub, "อีกคน");
    hub.handleMessage(other, { type: "play_ai", level: "easy" });

    hub.handleMessage(player, { type: "list_players" });
    for (const listed of player.last("players")!.players) expect(listed.id.startsWith("bot_")).toBe(false);
  });

  test("ขอเล่นใหม่กับบอทได้ทันทีโดยไม่ต้องรอใครตอบ", () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "hard" });
    const firstMatch = player.last("match_start")!.matchId;

    hub.handleMessage(player, { type: "resign" });
    hub.handleMessage(player, { type: "rematch" });
    expect(player.last("match_start")!.matchId).not.toBe(firstMatch);
  });

  test("ขอเล่นใหม่กับบอทแล้วบอทยังเป็นบอทอยู่ ไม่กลายเป็นคนหลุดการเชื่อมต่อ", async () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "easy" });
    const first = player.last("match_start")!;
    expect(first.players.filter((p) => p.bot).length).toBe(1);

    hub.handleMessage(player, { type: "resign" });
    hub.handleMessage(player, { type: "rematch" });

    const second = player.last("match_start")!;
    expect(second.matchId).not.toBe(first.matchId);
    const bot = second.players.find((p) => p.id !== player.last("session")!.id)!;
    expect(bot.bot).toBe("easy");
    expect(bot.connected).toBe(true);
    expect(bot.name).toBe("AI");

    // และต้องเดินให้จริง ไม่ใช่ค้างรอคนที่ไม่มีอยู่
    const you = second.you;
    if (player.last("state")!.state.current === you) playHumanTurn(hub, player);
    await Bun.sleep(150);
    expect(player.last("state")!.state.turn).toBeGreaterThan(1);
  });

  test("ออกจากเกมแล้ว session ของบอทถูกเก็บกวาด", () => {
    const hub = aiHub();
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "easy" });
    expect(hub.stats.sessions).toBe(2);

    hub.handleMessage(player, { type: "leave_match" });
    expect(hub.stats.matches).toBe(0);
    expect(hub.stats.sessions).toBe(1);
  });

  test("เล่นกับบอทจนจบเกมได้ และคะแนนรวมเท่ากับหมากที่หายไป", async () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 0 });
    hubs.push(hub);
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "easy" });
    const you = player.last("match_start")!.you;

    for (let i = 0; i < 80; i++) {
      const state = player.last("state")!.state;
      if (state.status !== "active") break;
      if (state.current === you) playHumanTurn(hub, player);
      else await Bun.sleep(5);
    }

    const end = player.last("match_end");
    const state = player.last("state")!.state;
    const captured = 60 - state.board.filter((cell) => cell >= 0).length;
    expect(state.scores[0] + state.scores[1]).toBe(captured);
    if (end) expect(end.stats.turns).toBe(end.history.length);
  });
});

describe("Challenge", () => {
  test("ท้าแล้วตอบรับ ได้ match", () => {
    const hub = newHub();
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "list_players" });
    const target = a.last("players")!.players[0];
    expect(target.name).toBe("B");

    hub.handleMessage(a, { type: "challenge", targetId: target.id });
    const incoming = b.last("challenge_in")!;
    expect(incoming.from.name).toBe("A");
    expect(a.last("challenge_update")!.status).toBe("PENDING");

    hub.handleMessage(b, { type: "challenge_respond", challengeId: incoming.id, accept: true });
    expect(a.last("challenge_update")!.status).toBe("ACCEPTED");
    expect(a.last("match_start")!.matchId).toBe(b.last("match_start")!.matchId);
  });

  test("ปฏิเสธคำท้าแล้วไม่มี match", () => {
    const hub = newHub();
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "list_players" });
    hub.handleMessage(a, { type: "challenge", targetId: a.last("players")!.players[0].id });
    hub.handleMessage(b, { type: "challenge_respond", challengeId: b.last("challenge_in")!.id, accept: false });
    expect(a.last("challenge_update")!.status).toBe("DECLINED");
    expect(a.last("match_start")).toBeUndefined();
    expect(hub.stats.matches).toBe(0);
  });
});

describe("Authoritative match", () => {
  function pairUp(hub: Hub) {
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });
    const seatA = a.last("match_start")!.you;
    return { a, b, mover: seatA === 0 ? a : b, waiter: seatA === 0 ? b : a };
  }

  test("ผู้เล่นที่ยังไม่ถึงตาสั่งอะไรไม่ได้", () => {
    const hub = newHub();
    const { mover, waiter } = pairUp(hub);
    const square = mover.last("state")!.state.selectable[0];
    hub.handleMessage(waiter, { type: "select", square });
    expect(waiter.last("error")!.code).toBe("not_your_turn");
  });

  test("เลือกช่องที่เล่นไม่ได้ถูกปฏิเสธ และ state ไม่เปลี่ยน", () => {
    const hub = newHub();
    const { mover } = pairUp(hub);
    const before = mover.last("state")!.state.stateHash;
    hub.handleMessage(mover, { type: "select", square: 27 }); // ช่องกลางที่ว่างอยู่
    expect(mover.last("error")!.code).toBe("empty_square");
    expect(mover.last("state")!.state.stateHash).toBe(before);
  });

  test("กินสำเร็จ ได้คะแนนและสลับตา ทั้งสองฝั่งเห็น state เดียวกัน", () => {
    const hub = newHub();
    const { a, b, mover } = pairUp(hub);
    const state = mover.last("state")!.state;
    const seat = mover.last("match_start")!.you;

    // หาหมากที่กินได้จริงในเทิร์นแรก
    hub.handleMessage(mover, { type: "select", square: state.selectable[0] });
    let view = mover.last("state")!.state;
    if (view.targetKind !== "capture") {
      for (const square of state.selectable) {
        hub.handleMessage(mover, { type: "select", square });
        view = mover.last("state")!.state;
        if (view.targetKind === "capture") break;
      }
    }
    expect(view.targetKind).toBe("capture");

    hub.handleMessage(mover, { type: "capture", to: view.targets[0] });
    const after = mover.last("state")!.state;
    expect(after.scores[seat]).toBe(1);
    expect(after.current).not.toBe(seat);
    expect(after.board.filter((cell) => cell >= 0).length).toBe(59);
    expect(a.last("state")!.state.stateHash).toBe(b.last("state")!.state.stateHash);
  });

  test("reconnect ได้ state ปัจจุบันกลับมาครบ", () => {
    const hub = newHub();
    const { a, b } = pairUp(hub);
    const token = a.last("session")!.token;
    const hashBefore = a.last("state")!.state.stateHash;

    hub.handleClose(a);
    expect(b.last("player_status")!.connected).toBe(false);

    const back = connect(hub, undefined, token);
    expect(back.last("match_start")!.matchId).toBe(a.last("match_start")!.matchId);
    expect(back.last("state")!.state.stateHash).toBe(hashBefore);
    expect(b.last("player_status")!.connected).toBe(true);
  });

  test("ยอมแพ้แล้วอีกฝ่ายชนะ", () => {
    const hub = newHub();
    const { a, b, mover, waiter } = pairUp(hub);
    hub.handleMessage(mover, { type: "resign" });
    const end = a.last("match_end")!;
    expect(end.result.reason).toBe("resign");
    expect(end.result.winners).toEqual([waiter.last("match_start")!.you]);
    expect(b.last("match_end")!.matchId).toBe(end.matchId);
  });

  test("โหวตจบเกม: ฝ่ายหนึ่งเสนอ อีกฝ่ายรับ", () => {
    const hub = newHub();
    const { a, mover, waiter } = pairUp(hub);
    hub.handleMessage(mover, { type: "offer_end" });
    expect(waiter.last("end_offer")!.by).toBe(mover.last("match_start")!.you);
    hub.handleMessage(waiter, { type: "respond_end", accept: true });
    expect(a.last("match_end")!.result.reason).toBe("agreement");
  });

  test("ขอเล่นใหม่ต้องครบทั้งสองฝ่าย และสลับที่นั่ง", () => {
    const hub = newHub();
    const { a, b, mover } = pairUp(hub);
    const firstMatch = a.last("match_start")!.matchId;
    const seatBefore = a.last("match_start")!.you;

    hub.handleMessage(mover, { type: "resign" });
    hub.handleMessage(a, { type: "rematch" });
    expect(a.last("match_start")!.matchId).toBe(firstMatch);

    hub.handleMessage(b, { type: "rematch" });
    expect(a.last("match_start")!.matchId).not.toBe(firstMatch);
    expect(a.last("match_start")!.you).not.toBe(seatBefore);
    expect(a.last("state")!.state.board.filter((cell) => cell >= 0).length).toBe(60);
  });

  test("บันทึกประวัติการเดินไว้ให้ replay ได้", () => {
    const hub = newHub();
    const { a, mover } = pairUp(hub);
    const state = mover.last("state")!.state;
    hub.handleMessage(mover, { type: "select", square: state.selectable[0] });
    const view = mover.last("state")!.state;
    hub.handleMessage(mover, { type: view.targetKind === "capture" ? "capture" : "move", to: view.targets[0] } as never);
    hub.handleMessage(mover, { type: "resign" });

    const end = a.last("match_end")!;
    expect(end.history.length).toBeGreaterThanOrEqual(1);
    expect(end.history[0].path.length).toBeGreaterThanOrEqual(2);
    expect(end.stats.turns).toBe(end.history.length);
  });
});

describe("Turn timer และ AI คุมแทน", () => {
  test("หมดเวลาแล้ว AI เข้าคุมที่นั่งและเดินต่อให้", async () => {
    const hub = new Hub({ defaultTurnSeconds: 1, botStepDelayMs: 5 });
    hubs.push(hub);
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });

    const idleSeat = a.last("state")!.state.current;
    await Bun.sleep(1300);

    expect(a.last("info")!.code).toBe("turn_timeout_autopilot");
    expect(a.last("autopilot")!.seat).toBe(idleSeat);
    expect(a.last("autopilot")!.on).toBe(true);
    expect(a.last("state")!.state.autopilot).toContain(idleSeat);
    expect(a.last("state")!.state.turn).toBeGreaterThan(1);
  });

  test("เจ้าของที่นั่งลงมือเองเมื่อไร ก็ได้คุมกลับคืนทันที", async () => {
    const hub = new Hub({ defaultTurnSeconds: 1, botStepDelayMs: 5 });
    hubs.push(hub);
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });

    const idleSeat = a.last("state")!.state.current;
    const idle = a.last("match_start")!.you === idleSeat ? a : b;
    await Bun.sleep(1300);
    expect(a.last("state")!.state.autopilot).toContain(idleSeat);

    // ขอเลือกหมาก แม้ยังไม่ถึงตาก็ถือว่ากลับมาแล้ว
    hub.handleMessage(idle, { type: "select", square: 0 });
    expect(a.last("state")!.state.autopilot).not.toContain(idleSeat);
    expect(a.last("autopilot")!.on).toBe(false);
  });

  test("หลุดการเชื่อมต่อแล้ว AI เข้าคุมหลังพ้นเวลารอ และคืนคุมเมื่อ reconnect", async () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 5, autopilotGraceMs: 30 });
    hubs.push(hub);
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });

    const seatA = a.last("match_start")!.you;
    // ให้ถึงตา A พอดีตอนหลุด จะได้เห็นว่า AI เดินต่อให้จริง
    if (a.last("state")!.state.current !== seatA) playHumanTurn(hub, b);
    const turnBefore = a.last("state")!.state.turn;

    const token = a.last("session")!.token;
    hub.handleClose(a);
    await Bun.sleep(120);

    expect(b.last("state")!.state.autopilot).toContain(seatA);
    // เกมเดินต่อได้ ไม่ค้างเพราะคนหาย
    expect(b.last("state")!.state.turn).toBeGreaterThan(turnBefore);

    const back = connect(hub, undefined, token);
    expect(back.last("state")!.state.autopilot).not.toContain(seatA);
    expect(b.last("autopilot")!.on).toBe(false);
  });

  test("ออกจากเกมไม่ใช่การยอมแพ้ — AI คุมที่นั่งต่อและคะแนนยังอยู่", async () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 5 });
    hubs.push(hub);
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });
    const seatA = a.last("match_start")!.you;

    hub.handleMessage(a, { type: "leave_match" });
    expect(b.last("match_end")).toBeUndefined();
    expect(b.last("state")!.state.autopilot).toContain(seatA);
    expect(b.last("state")!.state.retired).not.toContain(seatA);
  });

  test("ยอมแพ้ยังเป็นการถอนตัวถาวร ไม่ใช่ให้ AI คุม", () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 5 });
    hubs.push(hub);
    const a = connect(hub, "A");
    const b = connect(hub, "B");
    hub.handleMessage(a, { type: "quick_match" });
    hub.handleMessage(b, { type: "quick_match" });

    hub.handleMessage(a, { type: "resign" });
    expect(b.last("match_end")!.result.reason).toBe("resign");
    expect(b.last("match_end")!.result.winners).toEqual([b.last("match_start")!.you]);
  });
});

describe("ห้อง Public และ 2–4 ผู้เล่น", () => {
  test("ห้อง public โผล่ในรายการ ส่วน private ไม่โผล่", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const seeker = connect(hub, "Seeker");

    hub.handleMessage(host, { type: "create_room", visibility: "public", capacity: 3 });
    hub.handleMessage(seeker, { type: "list_rooms" });
    const listed = seeker.last("rooms")!.rooms;
    expect(listed.length).toBe(1);
    expect(listed[0].hostName).toBe("Host");
    expect(listed[0].capacity).toBe(3);
    expect(listed[0].players).toBe(1);
    // ไม่เปิดเผยรหัสห้องในรายการสาธารณะ
    expect(JSON.stringify(listed[0])).not.toContain(host.last("room")!.room.code);

    hub.handleMessage(host, { type: "leave_room" });
    const other = connect(hub, "Other");
    hub.handleMessage(other, { type: "create_room", visibility: "private" });
    hub.handleMessage(seeker, { type: "list_rooms" });
    expect(seeker.last("rooms")!.rooms.length).toBe(0);
  });

  test("เข้าห้องจากรายการด้วย room id ได้", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");
    hub.handleMessage(host, { type: "create_room", visibility: "public" });
    hub.handleMessage(guest, { type: "list_rooms" });

    hub.handleMessage(guest, { type: "join_room", code: guest.last("rooms")!.rooms[0].id });
    expect(guest.last("room")!.room.players.length).toBe(2);
  });

  test("ห้องเต็มตามจำนวนที่ตั้งไว้", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    hub.handleMessage(host, { type: "create_room", capacity: 2 });
    const code = host.last("room")!.room.code;

    const second = connect(hub, "Second");
    hub.handleMessage(second, { type: "join_room", code });
    const third = connect(hub, "Third");
    hub.handleMessage(third, { type: "join_room", code });
    expect(third.last("error")!.code).toBe("room_full");
  });

  test("เล่น 4 คนได้ เทิร์นวนครบทุกที่นั่ง", () => {
    const hub = newHub();
    const host = connect(hub, "P1");
    hub.handleMessage(host, { type: "create_room", capacity: 4, visibility: "public" });
    const code = host.last("room")!.room.code;

    const others = ["P2", "P3", "P4"].map((name) => {
      const conn = connect(hub, name);
      hub.handleMessage(conn, { type: "join_room", code });
      return conn;
    });
    expect(host.last("room")!.room.players.length).toBe(4);

    hub.handleMessage(host, { type: "start_room" });
    const state = host.last("state")!.state;
    expect(state.playerCount).toBe(4);
    expect(state.scores).toEqual([0, 0, 0, 0]);
    expect(host.last("match_start")!.players.length).toBe(4);

    // ที่นั่งถูกสุ่ม แต่ต้องครบทุกคนและไม่ซ้ำกัน
    const seats = [host, ...others].map((conn) => conn.last("match_start")!.you);
    expect([...seats].sort()).toEqual([0, 1, 2, 3]);
    expect(state.current).toBe(0);
  });

  test("เจ้าของห้องเพิ่ม/เอา AI ออกได้ และเริ่มเกมกับ AI ได้เลย", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    hub.handleMessage(host, { type: "create_room", capacity: 3, visibility: "public" });

    hub.handleMessage(host, { type: "add_bot", level: "hard" });
    hub.handleMessage(host, { type: "add_bot", level: "easy" });
    let room = host.last("room")!.room;
    expect(room.players.length).toBe(3);
    expect(room.players.filter((p) => p.bot).length).toBe(2);
    expect(room.players[1].bot).toBe("hard");
    expect(room.players[1].connected).toBe(true);

    // ห้องเต็มแล้วเพิ่มอีกไม่ได้
    hub.handleMessage(host, { type: "add_bot" });
    expect(host.last("error")!.code).toBe("room_full_for_bot");

    hub.handleMessage(host, { type: "remove_bot", playerId: room.players[2].id });
    room = host.last("room")!.room;
    expect(room.players.length).toBe(2);

    hub.handleMessage(host, { type: "start_room" });
    expect(host.last("state")!.state.playerCount).toBe(2);
    // ลำดับที่นั่งถูกสุ่ม บอทจึงอยู่ที่นั่งไหนก็ได้
    expect(host.last("match_start")!.players.filter((p) => p.bot === "hard").length).toBe(1);
  });

  test("คนที่ไม่ใช่เจ้าของห้องยุ่งกับ AI ไม่ได้", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");
    hub.handleMessage(host, { type: "create_room", capacity: 4 });
    hub.handleMessage(guest, { type: "join_room", code: host.last("room")!.room.code });

    hub.handleMessage(guest, { type: "add_bot", level: "easy" });
    expect(guest.last("error")!.code).toBe("not_room_host_bots");
    expect(host.last("room")!.room.players.length).toBe(2);
  });

  test("ปิดห้องแล้ว session ของ AI ในห้องถูกเก็บกวาด", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    hub.handleMessage(host, { type: "create_room", capacity: 4 });
    hub.handleMessage(host, { type: "add_bot", level: "easy" });
    hub.handleMessage(host, { type: "add_bot", level: "easy" });
    expect(hub.stats.sessions).toBe(3);

    hub.handleMessage(host, { type: "leave_room" });
    expect(hub.stats.rooms).toBe(0);
    expect(hub.stats.sessions).toBe(1);
  });

  test("รายการห้อง public บอกด้วยว่ามี AI กี่ตัว", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const seeker = connect(hub, "Seeker");
    hub.handleMessage(host, { type: "create_room", capacity: 4, visibility: "public" });
    hub.handleMessage(host, { type: "add_bot", level: "normal" });

    hub.handleMessage(seeker, { type: "list_rooms" });
    const listed = seeker.last("rooms")!.rooms[0];
    expect(listed.players).toBe(2);
    expect(listed.bots).toBe(1);
  });

  test("เริ่มเกมจากห้องแล้วลำดับที่นั่งถูกสุ่ม ไม่ใช่เจ้าของห้องได้ก่อนทุกครั้ง", () => {
    // สุ่มจึงต้องดูหลายเกมถึงจะเห็นว่าไม่ได้ตายตัว
    const seatsSeen = new Set<number>();
    for (let round = 0; round < 40 && seatsSeen.size < 2; round++) {
      const hub = newHub();
      const host = connect(hub, "Host");
      const guest = connect(hub, "Guest");
      hub.handleMessage(host, { type: "create_room", capacity: 2 });
      hub.handleMessage(guest, { type: "join_room", code: host.last("room")!.room.code });
      hub.handleMessage(host, { type: "start_room" });
      seatsSeen.add(host.last("match_start")!.you);
    }
    expect(seatsSeen).toEqual(new Set([0, 1]));
  });

  test("บอกทุกคนว่าใครได้เดินก่อน", () => {
    const hub = newHub();
    const host = connect(hub, "Host");
    const guest = connect(hub, "Guest");
    hub.handleMessage(host, { type: "create_room", capacity: 2 });
    hub.handleMessage(guest, { type: "join_room", code: host.last("room")!.room.code });
    hub.handleMessage(host, { type: "start_room" });

    const info = host.last("info")!;
    expect(info.code).toBe("first_player");
    const firstSeat = host.last("state")!.state.current;
    expect(info.params!.name).toBe(host.last("match_start")!.players[firstSeat].name);
    expect(guest.last("info")!.code).toBe("first_player");
  });

  test("เกม 3 คน: คนหนึ่งยอมแพ้ อีกสองคนเล่นต่อ", () => {
    const hub = newHub();
    const host = connect(hub, "P1");
    hub.handleMessage(host, { type: "create_room", capacity: 3 });
    const code = host.last("room")!.room.code;
    const p2 = connect(hub, "P2");
    const p3 = connect(hub, "P3");
    hub.handleMessage(p2, { type: "join_room", code });
    hub.handleMessage(p3, { type: "join_room", code });
    hub.handleMessage(host, { type: "start_room" });

    hub.handleMessage(p2, { type: "resign" });
    expect(host.last("match_end")).toBeUndefined();
    expect(host.last("state")!.state.retired).toEqual([seatOf(p2)]);
    expect(host.last("state")!.state.status).toBe("active");

    hub.handleMessage(p3, { type: "resign" });
    expect(host.last("match_end")!.result.winners).toEqual([seatOf(host)]);
  });

  test("ผู้เสนอถอนคำขอจบเกมเองได้ และโหวตเก่าไม่ค้าง", () => {
    const hub = newHub();
    const host = connect(hub, "P1");
    hub.handleMessage(host, { type: "create_room", capacity: 3 });
    const code = host.last("room")!.room.code;
    const p2 = connect(hub, "P2");
    const p3 = connect(hub, "P3");
    hub.handleMessage(p2, { type: "join_room", code });
    hub.handleMessage(p3, { type: "join_room", code });
    hub.handleMessage(host, { type: "start_room" });

    hub.handleMessage(host, { type: "offer_end" });
    hub.handleMessage(p2, { type: "respond_end", accept: true });
    expect(host.last("state")!.state.endVotes.sort()).toEqual([seatOf(host), seatOf(p2)].sort());
    expect(host.last("state")!.state.endVotesNeeded).toBe(3);

    // ผู้เสนอถอนเอง โหวตต้องถูกล้างทั้งหมด ไม่ใช่เหลือค้าง
    hub.handleMessage(host, { type: "respond_end", accept: false });
    expect(host.last("info")!.code).toBe("end_offer_cancelled");
    expect(host.last("state")!.state.endOfferBy).toBeNull();
    expect(host.last("state")!.state.endVotes).toEqual([]);
    expect(host.last("match_end")).toBeUndefined();

    // เสนอใหม่แล้วเริ่มนับหนึ่งใหม่ ไม่ใช่ต่อจากของเก่า
    hub.handleMessage(p2, { type: "offer_end" });
    expect(host.last("state")!.state.endVotes).toEqual([seatOf(p2)]);
  });

  test("คนถอนตัวกลางโหวตแล้วจำนวนเสียงที่ต้องการลดลงตาม", () => {
    const hub = newHub();
    const host = connect(hub, "P1");
    hub.handleMessage(host, { type: "create_room", capacity: 3 });
    const code = host.last("room")!.room.code;
    const p2 = connect(hub, "P2");
    const p3 = connect(hub, "P3");
    hub.handleMessage(p2, { type: "join_room", code });
    hub.handleMessage(p3, { type: "join_room", code });
    hub.handleMessage(host, { type: "start_room" });

    hub.handleMessage(host, { type: "offer_end" });
    hub.handleMessage(p2, { type: "respond_end", accept: true });
    expect(host.last("match_end")).toBeUndefined();

    // เหลือสองคนที่ยังเล่นอยู่และทั้งคู่โหวตไปแล้ว เกมจึงต้องจบทันที
    hub.handleMessage(p3, { type: "resign" });
    expect(host.last("match_end")!.result.reason).toBe("agreement");
  });

  test("บอทไม่ต้องโหวต เล่นกับ AI แล้วขอจบเกมจบได้ทันที", async () => {
    const hub = new Hub({ defaultTurnSeconds: 0, botStepDelayMs: 2 });
    hubs.push(hub);
    const player = connect(hub, "เก้า");
    hub.handleMessage(player, { type: "play_ai", level: "easy" });
    await Bun.sleep(30);

    hub.handleMessage(player, { type: "offer_end" });
    expect(player.last("match_end")!.result.reason).toBe("agreement");
  });

  test("โหวตจบเกม 3 คน ต้องครบทุกคนที่ยังอยู่", () => {
    const hub = newHub();
    const host = connect(hub, "P1");
    hub.handleMessage(host, { type: "create_room", capacity: 3 });
    const code = host.last("room")!.room.code;
    const p2 = connect(hub, "P2");
    const p3 = connect(hub, "P3");
    hub.handleMessage(p2, { type: "join_room", code });
    hub.handleMessage(p3, { type: "join_room", code });
    hub.handleMessage(host, { type: "start_room" });

    hub.handleMessage(host, { type: "offer_end" });
    hub.handleMessage(p2, { type: "respond_end", accept: true });
    expect(host.last("match_end")).toBeUndefined();
    expect(host.last("state")!.state.endVotes.sort()).toEqual([seatOf(host), seatOf(p2)].sort());

    hub.handleMessage(p3, { type: "respond_end", accept: true });
    expect(host.last("match_end")!.result.reason).toBe("agreement");
  });
});
