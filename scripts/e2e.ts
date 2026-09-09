/**
 * ทดสอบ end-to-end กับเซิร์ฟเวอร์ที่รันอยู่จริง (transport + hub + engine)
 * ใช้: bun scripts/e2e.ts [http://localhost:3000]
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";

class Client {
  socket: WebSocket;
  inbox: any[] = [];
  constructor(public label: string) {
    this.socket = new WebSocket(WS_URL);
    this.socket.addEventListener("message", (e) => this.inbox.push(JSON.parse(String(e.data))));
  }
  async ready() {
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
  async wait(type: string, timeoutMs = 3000): Promise<any> {
    return this.after(0, type, timeoutMs);
  }
  /** รอข้อความที่มาถึง "หลัง" ตำแหน่ง mark เท่านั้น กันไม่ให้หยิบข้อความเก่ามาตอบ */
  async after(mark: number, type: string, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.inbox.slice(mark).filter((m) => m.type === type).pop();
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`[${this.label}] ไม่ได้รับข้อความชนิด "${type}" ภายใน ${timeoutMs}ms`);
  }
  /** ส่งคำสั่งแล้วรอผลลัพธ์ที่เกิดจากคำสั่งนั้นจริง ๆ */
  async act(message: unknown, type = "state"): Promise<any> {
    const mark = this.inbox.length;
    this.send(message);
    return this.after(mark, type);
  }
  latest(type: string) {
    return this.inbox.filter((m) => m.type === type).pop();
  }
  clear() {
    this.inbox = [];
  }
}

const checks: string[] = [];
function check(label: string, condition: unknown) {
  if (!condition) throw new Error(`ไม่ผ่าน: ${label}`);
  checks.push(label);
}

const a = new Client("A");
const b = new Client("B");
await Promise.all([a.ready(), b.ready()]);

a.send({ type: "hello", name: "อาทิตย์" });
b.send({ type: "hello", name: "บุญมี" });
const sessionA = await a.wait("session");
const sessionB = await b.wait("session");
check("guest session ถูกสร้างให้ทั้งสองฝั่ง", sessionA.id !== sessionB.id && sessionA.name === "อาทิตย์");

// ── Private room + invite link ────────────────────────────────────────────
a.send({ type: "create_room" });
const room = (await a.wait("room")).room;
check("สร้างห้องได้พร้อมรหัสและลิงก์เชิญ", /^[A-Z2-9]{6}$/.test(room.code) && room.inviteUrl.endsWith(room.code));

const invitePage = await fetch(room.inviteUrl);
check("ลิงก์เชิญเสิร์ฟหน้าเกมได้ (HTTP 200)", invitePage.status === 200 && (await invitePage.text()).includes("หมากสี่กระดาน"));

b.send({ type: "join_room", code: room.code });
await b.wait("room");
a.send({ type: "start_room" });

const startA = await a.wait("match_start");
const startB = await b.wait("match_start");
check("เริ่ม match จากห้องได้ และทั้งคู่อยู่ match เดียวกัน", startA.matchId === startB.matchId && startA.you !== startB.you);

const state0 = (await a.wait("state")).state;
check("กระดานเริ่มต้นมีหมาก 60 ตัว", state0.board.filter((c: number) => c >= 0).length === 60);
check("มีหมากให้เลือก 32 ตัวในเทิร์นแรก", state0.selectable.length === 32);

// ── เล่นจริง 10 เทิร์น ────────────────────────────────────────────────────
const bySeat = [startA.you === 0 ? a : b, startA.you === 0 ? b : a];
let totalCaptures = 0;

for (let move = 0; move < 10; move++) {
  const view = bySeat[0].latest("state").state;
  if (view.status !== "active") break;
  const client = bySeat[view.current];

  // client ไม่รู้กติกา จึงเลือกหมากไปเรื่อย ๆ แล้วดูจาก targets ที่ server ตอบกลับ
  let current = view;
  for (const square of view.selectable) {
    current = (await client.act({ type: "select", square })).state;
    if (current.targetKind === "capture") break;
  }

  const scoreBefore = current.scores[view.current];
  while (current.status === "active" && current.selection && current.current === view.current) {
    const kind = current.targetKind === "capture" ? "capture" : "move";
    current = (await client.act({ type: kind, to: current.targets[0] })).state;
  }
  totalCaptures += current.scores[view.current] - scoreBefore;

  const other = bySeat[view.current === 0 ? 1 : 0].latest("state").state;
  if (process.env.E2E_DEBUG) console.log("turn", current.turn, "scores", current.scores, "targetKind", current.targetKind);
  check(`เทิร์น ${move + 1}: ทั้งสองฝั่งเห็น state hash ตรงกัน`, other.stateHash === current.stateHash);
}

const played = bySeat[0].latest("state").state;
check("เดินไปแล้วหลายเทิร์นและมีการกินเกิดขึ้น", played.turn > 5 && totalCaptures > 0);
check("หมากบนกระดานลดลงเท่ากับคะแนนรวม", 60 - played.board.filter((c: number) => c >= 0).length === played.scores[0] + played.scores[1]);

// ── โหมดกระดานจริง: ไม่ชี้เป้า ไม่บังคับกินจนสุด ─────────────────────────
{
  const x = new Client("X"); const y = new Client("Y");
  await Promise.all([x.ready(), y.ready()]);
  x.send({ type: "hello", name: "โต๊ะ X" }); y.send({ type: "hello", name: "โต๊ะ Y" });
  await x.after(0, "session"); await y.after(0, "session");

  const created = await x.act({ type: "create_room", mode: "table", capacity: 2 }, "room");
  const tableRoom = created.room;
  check("ห้องจำโหมดกติกาที่ตั้งไว้", tableRoom.mode === "table");
  await y.act({ type: "join_room", code: tableRoom.code }, "room");
  const startX = await x.act({ type: "start_room" }, "match_start");

  const seatX = startX.you;
  await Bun.sleep(50);
  const mover = x.latest("state").state.current === seatX ? x : y;
  const view = mover.latest("state").state;
  check("โหมดกระดานจริงไม่บอกว่าหมากตัวไหนเล่นได้", view.selectable.length === 0);
  check("โหมดกระดานจริงไม่บังคับ Maximum Capture", view.rules.forceMaximum === false);
  check("โหมดกระดานจริงบังคับจับแล้วเดิน", view.rules.touchMove === true);

  // ผู้เล่นต้องหาเองว่าหมากตัวไหนกินได้ — ลองหยิบตัวที่กินไม่ได้ก่อน
  const blind = await mover.act({ type: "select", square: 0 }, "error");
  check("หยิบหมากที่เล่นไม่ได้ถูกปฏิเสธด้วย code ที่ client แปลเองได้", typeof blind.code === "string" && !("message" in blind));

  // b7 คือหนึ่งใน 20 ตัวที่กระโดดลงช่องกลางได้ (จาก probe ของกระดานเริ่มต้น)
  const from = 9;   // (1,1)
  const to = 27;    // (3,3) ช่องกลาง
  const selected = await mover.act({ type: "select", square: from });
  check("หยิบหมากได้โดย server ไม่เฉลยช่องปลายทาง", selected.state.targets.length === 0);
  const played = await mover.act({ type: "play", to });
  check("วางหมากลงช่องแล้ว server ตีความเองว่าเป็นการกิน", played.state.scores[view.current] === 1);
  check("โหมดนี้บันทึกไว้ว่าตานั้นพลาดโอกาสไปเท่าไร", typeof played.state.lastTurn.missedCaptures === "number");

  x.socket.close(); y.socket.close();
}

// ── ข้อความเป็น code ไม่ใช่ข้อความสำเร็จรูป ─────────────────────────────
{
  const catalogTh = await (await fetch(`${BASE}/api/v1/messages?locale=th`)).json();
  const catalogEn = await (await fetch(`${BASE}/api/v1/messages?locale=en`)).json();
  check("ดึงแคตตาล็อกข้อความได้ทั้งสองภาษา", catalogTh.locale === "th" && catalogEn.locale === "en");
  check("code เดียวกันมีข้อความคนละภาษา", catalogTh.messages.not_your_turn !== catalogEn.messages.not_your_turn);
  check("แคตตาล็อกมีครบทุก code เท่ากันทุกภาษา",
    Object.keys(catalogTh.messages).length === Object.keys(catalogEn.messages).length);
}

// ── กันการโกงจาก client ──────────────────────────────────────────────────
const wrongTurn = bySeat[played.current === 0 ? 1 : 0];
wrongTurn.clear();
wrongTurn.send({ type: "select", square: played.selectable[0] });
check("client ที่ยังไม่ถึงตาถูกปฏิเสธ", (await wrongTurn.wait("error")).code === "not_your_turn");

const turnClient = bySeat[played.current];
turnClient.clear();
turnClient.send({ type: "capture", to: 0 });
check("สั่งกินโดยไม่เลือกหมากถูกปฏิเสธ", (await turnClient.wait("error")).code === "no_piece_selected");

// ── Reconnect ────────────────────────────────────────────────────────────
const hashBefore = played.stateHash;
a.socket.close();
await Bun.sleep(150);
const aBack = new Client("A2");
await aBack.ready();
aBack.send({ type: "hello", token: sessionA.token });
const resumed = await aBack.wait("state");
check("reconnect ด้วย token เดิมแล้วได้ state เดิมกลับมา", resumed.state.stateHash === hashBefore);
check("reconnect แล้วยังนั่งที่นั่งเดิม", (await aBack.wait("match_start")).you === startA.you);

// ── จบเกม ────────────────────────────────────────────────────────────────
aBack.send({ type: "resign" });
const end = await aBack.wait("match_end");
check("ยอมแพ้แล้วอีกฝ่ายชนะ", end.result.reason === "resign" && end.result.winner !== startA.you);
check("ผลเกมมีสถิติครบ (เทิร์น/chain สูงสุด/ประวัติ)", end.stats.turns === end.history.length && end.stats.players[0].bestChain >= 0);

aBack.socket.close();
b.socket.close();

console.log(`\n✓ ผ่านทั้งหมด ${checks.length} ข้อ\n`);
for (const item of checks) console.log("  ✓ " + item);
