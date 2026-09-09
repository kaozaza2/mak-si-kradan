/**
 * Client ของหมากสี่กระดาน
 *
 * ไม่ตัดสินกติกาเอง — ส่งแค่เจตนา (เลือกหมากตัวนี้ / ลงช่องนี้) แล้ววาดตาม
 * canonical state ที่เซิร์ฟเวอร์ส่งกลับมาเสมอ (§28)
 */

const CENTER_HOLES = new Set([27, 28, 35, 36]);
const MODE_NAMES = { assisted: "ช่วยคำนวณ", standard: "มาตรฐาน", table: "กระดานจริง" };

/**
 * เซิร์ฟเวอร์ส่งชื่อบอทมาเป็น "AI" เฉย ๆ พร้อมฟิลด์ bot บอกระดับ
 * และส่งชื่อว่างเมื่อไม่รู้จักผู้เล่นแล้ว — ชื่อที่คนอ่านประกอบที่นี่
 */
function playerName(player) {
  if (!player) return t("departed_player");
  if (player.bot) return t(`ai_${player.bot}`);
  return player.name || t("departed_player");
}
const FILES = "abcdefgh";
const TOKEN_KEY = "msk.token";
const NAME_KEY = "msk.name";
const SEEN_HELP_KEY = "msk.seenHelp";
const AUTH_KEY = "msk.auth";
const NODE_KEY = "msk.node";
/** ต้องตรงกับ PROTOCOL_VERSION ฝั่ง server */
const PROTOCOL_VERSION = 1;
const LOCALE_KEY = "msk.locale";

const $ = (id) => document.getElementById(id);
const el = {
  screens: {
    lobby: $("screen-lobby"),
    room: $("screen-room"),
    game: $("screen-game"),
    result: $("screen-result"),
  },
  nameInput: $("name-input"),
  sessionLine: $("session-line"),
  onlineCount: $("online-count"),
  queueBox: $("queue-box"),
  playersCard: $("players-card"),
  playersList: $("players-list"),
  joinCode: $("join-code"),
  turnSeconds: $("turn-seconds"),
  roomCapacity: $("room-capacity"),
  roomVisibility: $("room-visibility"),
  roomMode: $("room-mode"),
  endTurn: $("btn-end-turn"),
  roomsList: $("rooms-list"),
  roomMeta: $("room-meta"),
  scoreList: $("score-list"),
  helpModal: $("help-modal"),
  helpModes: $("help-modes"),
  authBox: $("auth-box"),
  guestBox: $("guest-box"),
  userBox: $("user-box"),
  authError: $("auth-error"),
  leaderboardCard: $("leaderboard-card"),
  otpBox: $("otp-box"),
  otpError: $("otp-error"),
  friendsCard: $("friends-card"),
  friendsList: $("friends-list"),
  friendRequests: $("friend-requests"),
  inviteModal: $("invite-modal"),
  offerEnd: $("btn-offer-end"),
  leaderboard: $("leaderboard"),
  roomCode: $("room-code"),
  roomPlayers: $("room-players"),
  roomStatus: $("room-status"),
  startRoom: $("btn-start-room"),
  board: $("board"),
  turnNo: $("turn-no"),
  timer: $("timer"),
  gameStatus: $("game-status"),
  chainBar: $("chain-bar"),
  cancelSelect: $("btn-cancel-select"),
  endOffer: $("end-offer"),
  log: $("log"),
  resultTitle: $("result-title"),
  resultScores: $("result-scores"),
  resultReason: $("result-reason"),
  resultStats: $("result-stats"),
  resultHistory: $("result-history"),
  rematchStatus: $("rematch-status"),
  challengeModal: $("challenge-modal"),
  challengeText: $("challenge-text"),
  toasts: $("toasts"),
};

const app = {
  socket: null,
  session: null,
  match: null, // { matchId, you, players, turnSeconds }
  state: null,
  room: null,
  incomingChallenge: null,
  clockSkew: 0,
  reconnectDelay: 500,
  pendingJoinCode: null,
  user: null,
  accountsEnabled: false,
  invite: null,
  /** node ที่ต้องต่อไป เมื่อห้อง/แมตช์ของเราอยู่คนละเครื่องกับที่ load balancer ส่งมา */
  serverUrl: sessionStorage.getItem(NODE_KEY) || "",
};

// ── ข้อความ ────────────────────────────────────────────────────────────────

/**
 * เซิร์ฟเวอร์ส่งมาแค่ code กับ params ตัวข้อความอยู่ที่นี่
 * ทำให้เปลี่ยนภาษาได้โดยไม่ต้องแตะเซิร์ฟเวอร์ และเช็ค error ด้วย code ได้
 */
let messages = {};

function t(code, params = {}) {
  const template = messages[code];
  if (!template) return code; // ยังโหลดแคตตาล็อกไม่เสร็จ หรือเป็น code ใหม่ที่ client ยังไม่รู้จัก
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = params[key];
    if (value === undefined) return whole;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

function preferredLocale() {
  const saved = localStorage.getItem(LOCALE_KEY);
  if (saved) return saved;
  return (navigator.language ?? "").toLowerCase().startsWith("th") ? "th" : "en";
}

async function loadMessages(locale) {
  try {
    const body = await api(`/api/v1/messages?locale=${encodeURIComponent(locale)}`);
    messages = body.messages ?? {};
  } catch {
    messages = {};
  }
}

// ── บัญชีผู้ใช้ ──────────────────────────────────────────────────────────────

const authToken = () => localStorage.getItem(AUTH_KEY);

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  // REST ก็ตอบเป็น code เหมือนกับ WebSocket ข้อความมาจากแคตตาล็อกฝั่ง client
  if (!response.ok) throw new Error(body.code ? t(body.code, body) : `HTTP ${response.status}`);
  return body;
}

function renderUser() {
  const user = app.user;
  const needsOtp = Boolean(user && user.email && !user.verified);

  el.userBox.classList.toggle("hidden", !user);
  el.guestBox.classList.toggle("hidden", Boolean(user));
  el.authBox.classList.toggle("hidden", Boolean(user) || !app.accountsEnabled);
  el.otpBox.classList.toggle("hidden", !needsOtp);
  if (!user) return;

  $("user-name").textContent = user.name;
  $("user-rating").textContent = `${user.rating}`;
  $("user-record").textContent =
    `ชนะ ${user.wins} · แพ้ ${user.losses} · เสมอ ${user.draws} · เล่นแล้ว ${user.gamesPlayed} เกม`;
  // ยังไม่ยืนยันก็เล่นได้ทุกอย่าง แค่ยังไม่เก็บ rating
  $("user-verify").textContent = needsOtp ? "ยังไม่ได้ยืนยันอีเมล — เกมของคุณจะยังไม่นับ rating" : "";
}

async function refreshUser() {
  if (!authToken()) return;
  try {
    app.user = (await api("/api/v1/me")).user;
  } catch {
    // token หมดอายุหรือ secret เปลี่ยน — กลับไปเป็น guest เงียบ ๆ
    localStorage.removeItem(AUTH_KEY);
    app.user = null;
  }
  renderUser();
}

async function refreshLeaderboard() {
  if (!app.accountsEnabled) return;
  try {
    const { leaderboard } = await api("/api/v1/leaderboard?limit=20");
    el.leaderboardCard.classList.remove("hidden");
    el.leaderboard.innerHTML = "";
    if (leaderboard.length === 0) {
      const li = document.createElement("li");
      li.textContent = "ยังไม่มีใครติดอันดับ — เล่นแมตช์ที่ทุกคนล็อกอินเพื่อเก็บ rating";
      li.style.gridTemplateColumns = "1fr";
      el.leaderboard.appendChild(li);
      return;
    }
    for (const row of leaderboard) {
      const li = document.createElement("li");
      if (app.user && row.id === app.user.id) li.classList.add("me");
      li.innerHTML =
        `<span class="rank">#${row.rank}</span>` +
        `<span>${escapeHtml(row.name)} <span class="muted">${row.wins}-${row.losses}-${row.draws}</span></span>` +
        `<span class="pts">${row.rating}</span>`;
      el.leaderboard.appendChild(li);
    }
  } catch {
    el.leaderboardCard.classList.add("hidden");
  }
}

async function applyAuthResult(result) {
  localStorage.setItem(AUTH_KEY, result.token);
  app.user = result.user;
  renderUser();
  await refreshLeaderboard();
  // เชื่อมต่อใหม่เพื่อให้ session ฝั่ง server ผูกกับบัญชีนี้
  app.socket?.close();
  toast(`ยินดีต้อนรับ ${result.user.name}`);
}

async function submitAuth(path) {
  el.authError.textContent = "";
  const identifier = $("auth-username").value.trim();
  const password = $("auth-password").value;
  const isEmail = identifier.includes("@");
  try {
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify({
        locale: preferredLocale(),
        ...(isEmail
          ? { email: identifier, password, displayName: identifier.split("@")[0] }
          : { username: identifier, password, displayName: identifier }),
      }),
    });
    await applyAuthResult(result);
    if (result.verificationRequired) toast(t(result.code ?? "verification_sent"));
  } catch (error) {
    el.authError.textContent = error.message;
  }
}

async function submitOtp() {
  el.otpError.textContent = "";
  try {
    const result = await api("/api/v1/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: app.user?.email, code: $("otp-code").value.trim() }),
    });
    await applyAuthResult(result);
    toast("ยืนยันอีเมลเรียบร้อย");
  } catch (error) {
    el.otpError.textContent = error.message;
  }
}

/**
 * ปุ่ม Google — โหลด Google Identity Services ตอนที่จำเป็นเท่านั้น
 * แล้วส่ง ID token ที่ได้ไปให้ server ตรวจ ซึ่งเป็นวิธีเดียวกับที่แอปมือถือจะใช้
 */
function setupGoogle(clientId) {
  if (!clientId) return;
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onload = () => {
    const google = window.google?.accounts?.id;
    if (!google) return;
    google.initialize({
      client_id: clientId,
      callback: async (response) => {
        el.authError.textContent = "";
        try {
          await applyAuthResult(
            await api("/api/v1/auth/google", {
              method: "POST",
              body: JSON.stringify({ idToken: response.credential }),
            }),
          );
        } catch (error) {
          el.authError.textContent = error.message;
        }
      },
    });
    const mount = $("google-signin");
    mount.classList.remove("hidden");
    google.renderButton(mount, { theme: "filled_black", size: "large", text: "continue_with", shape: "pill" });
  };
  // โหลดไม่ได้ก็แค่ไม่มีปุ่ม ทางอื่นยังใช้ได้ปกติ
  script.onerror = () => $("google-signin").classList.add("hidden");
  document.head.appendChild(script);
}

// ── การเชื่อมต่อ ─────────────────────────────────────────────────────────────

function websocketUrl() {
  if (app.serverUrl) {
    try {
      const target = new URL(app.serverUrl);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      target.pathname = "/ws";
      return target.toString();
    } catch {
      app.serverUrl = "";
      sessionStorage.removeItem(NODE_KEY);
    }
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

function connect() {
  const socket = new WebSocket(websocketUrl());
  app.socket = socket;

  socket.addEventListener("open", () => {
    app.reconnectDelay = 500;
    send({
      type: "hello",
      token: localStorage.getItem(TOKEN_KEY) ?? undefined,
      name: localStorage.getItem(NAME_KEY) ?? undefined,
      authToken: authToken() ?? undefined,
      protocol: PROTOCOL_VERSION,
    });
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(message);
  });

  socket.addEventListener("close", () => {
    el.sessionLine.textContent = "หลุดการเชื่อมต่อ — กำลังเชื่อมต่อใหม่…";
    setTimeout(connect, app.reconnectDelay);
    app.reconnectDelay = Math.min(app.reconnectDelay * 2, 8000);
  });
}

/** เวลาต่อเทิร์นที่ผู้เล่นเลือกไว้ใน lobby (0 = ไม่จำกัด) */
function chosenTurnSeconds() {
  return Number(el.turnSeconds.value);
}

function send(message) {
  if (app.socket?.readyState === WebSocket.OPEN) app.socket.send(JSON.stringify(message));
}

// ── ข้อความจากเซิร์ฟเวอร์ ────────────────────────────────────────────────────

function handle(message) {
  switch (message.type) {
    case "session": {
      app.session = message;
      localStorage.setItem(TOKEN_KEY, message.token);
      el.nameInput.value = message.name;
      el.sessionLine.textContent = `คุณคือ ${message.name} · ${message.id}`;
      if (message.kind === "user") {
        if (!app.user) refreshUser();
        send({ type: "list_friends" });
      } else {
        el.friendsCard.classList.add("hidden");
      }
      if (app.pendingJoinCode) {
        send({ type: "join_room", code: app.pendingJoinCode });
        app.pendingJoinCode = null;
      } else {
        send({ type: "list_rooms" });
      }
      break;
    }
    case "lobby":
      el.onlineCount.textContent =
        `Online Players: ${message.online} · ในเกม ${message.inMatch} · ในคิว ${message.inQueue}` +
        (message.nodes > 1 ? ` · ${message.nodes} เซิร์ฟเวอร์` : "");
      break;
    case "players":
      renderPlayers(message.players);
      break;
    case "rooms":
      renderRooms(message.rooms);
      break;
    case "friends":
      renderFriends(message);
      break;
    case "room_invite":
      app.invite = message;
      $("invite-text").textContent = `${message.from.name} ชวนคุณเข้าห้อง`;
      $("invite-detail").textContent =
        `${message.players}/${message.capacity} คน · กติกา${MODE_NAMES[message.mode] ?? message.mode} · ` +
        (message.turnSeconds > 0 ? `${message.turnSeconds} วินาทีต่อเทิร์น` : "ไม่จำกัดเวลา");
      el.inviteModal.classList.remove("hidden");
      break;
    case "queue":
      el.queueBox.classList.toggle("hidden", !message.searching);
      break;
    case "room":
      app.room = message.room;
      renderRoom();
      showScreen("room");
      if (app.user) send({ type: "list_friends" });
      break;
    case "room_closed":
      app.room = null;
      if (app.user) send({ type: "list_friends" });
      if (!app.match) showScreen("lobby");
      toast(t(message.code, message.params));
      break;
    case "redirect":
      // ห้องหรือคู่แข่งอยู่อีก node — ย้ายไปต่อที่นั่นแล้วเริ่ม session ใหม่ด้วย token เดิม
      if (message.url) {
        app.serverUrl = message.url;
        sessionStorage.setItem(NODE_KEY, message.url);
        toast(t(message.code, message.params));
        app.reconnectDelay = 200;
        app.socket?.close();
      }
      break;
    case "match_start":
      app.match = message;
      // จำไว้ว่าแมตช์นี้อยู่ node ไหน จะได้ต่อกลับถูกที่ตอนหลุด
      if (message.nodeUrl) {
        app.serverUrl = message.nodeUrl;
        sessionStorage.setItem(NODE_KEY, message.nodeUrl);
      }
      app.room = null;
      el.log.innerHTML = "";
      el.endOffer.classList.add("hidden");
      el.rematchStatus.textContent = "";
      showScreen("game");
      break;
    case "state":
      applyState(message.state);
      break;
    case "match_end":
      renderResult(message);
      showScreen("result");
      // เรตติ้งอาจเปลี่ยนถ้าแมตช์นี้นับคะแนน
      refreshUser();
      refreshLeaderboard();
      break;
    case "player_status":
      toast(`${message.name} ${message.connected ? "กลับเข้ามาแล้ว" : "หลุดการเชื่อมต่อ"}`);
      break;
    case "autopilot":
      toast(message.on ? `AI เข้าคุมที่นั่งของ ${message.name}` : `${message.name} กลับมาคุมเอง`);
      break;
    case "end_offer":
      // ตัวการ์ดวาดจาก state เพื่อให้ reconnect กลางโหวตแล้วยังเห็นสถานะถูกต้อง
      if (app.match && message.by !== app.match.you) {
        toast(t("end_offer_started", { name: playerName(app.state?.players?.[message.by]) }));
      }
      break;
    case "rematch_status": {
      const mine = app.session && message.requested.includes(app.session.id);
      el.rematchStatus.textContent = mine ? "รออีกฝ่ายตอบรับ…" : "อีกฝ่ายขอเล่นอีกครั้ง";
      break;
    }
    case "challenge_in":
      app.incomingChallenge = message;
      el.challengeText.textContent = `${message.from.name} ท้าคุณ`;
      el.challengeModal.classList.remove("hidden");
      break;
    case "challenge_update":
      if (message.status !== "PENDING") el.challengeModal.classList.add("hidden");
      if (message.status === "PENDING") toast("ส่งคำท้าแล้ว รอการตอบรับ…");
      if (message.status === "DECLINED") toast("อีกฝ่ายปฏิเสธคำท้า");
      if (message.status === "EXPIRED") toast("คำท้าหมดอายุ");
      break;
    case "info":
      toast(t(message.code, message.params));
      break;
    case "error":
      toast(t(message.code, message.params), true);
      break;
  }
}

// ── กระดาน ──────────────────────────────────────────────────────────────────

const cells = [];

function buildBoard() {
  el.board.innerHTML = "";
  cells.length = 0;
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    if (((i >> 3) + (i & 7)) % 2 === 1) cell.classList.add("odd");
    if (CENTER_HOLES.has(i)) cell.classList.add("center");
    cell.dataset.square = String(i);
    cell.addEventListener("click", () => onCellClick(i));
    el.board.appendChild(cell);
    cells.push(cell);
  }
}

function squareLabel(i) {
  return `${FILES[i % 8]}${8 - (i >> 3)}`;
}

function onCellClick(square) {
  const state = app.state;
  if (!state || !app.match || state.status !== "active") return;
  if (state.current !== app.match.you) return;

  if (state.targets.includes(square)) {
    send({ type: state.targetKind === "capture" ? "capture" : "move", to: square });
    return;
  }

  // โหมดช่วยคำนวณบอกช่องที่ลงได้ครบอยู่แล้ว คลิกนอกเหนือจากนั้นคือการเปลี่ยนหมาก
  if (state.rules.assist === "full") {
    if (state.selectable.includes(square)) send({ type: "select", square });
    return;
  }

  // โหมดที่ไม่ชี้เป้า: หยิบหมากแล้วก็แค่ "วางลง" ช่องที่ต้องการ
  // ให้ server ตีความเองว่าเป็นการกินหรือการเดิน เหมือนวางหมากลงกระดานจริง
  if (state.selection) {
    if (square !== state.selection.at) send({ type: "play", to: square });
    return;
  }
  send({ type: "select", square });
}

function applyState(state) {
  app.state = state;
  app.clockSkew = Date.now() - state.now;
  renderBoard();
  renderScoreboard();
  renderEndOffer();
  renderLog();
}

function renderBoard() {
  const state = app.state;
  const yourTurn = app.match && state.current === app.match.you && state.status === "active";
  const selectable = new Set(yourTurn ? state.selectable : []);
  const targets = new Set(yourTurn ? state.targets : []);
  const path = new Set(state.selection?.path ?? []);
  const eaten = new Set(state.selection?.capturedSquares ?? []);
  const trail = new Set(state.selection ? [] : (state.lastTurn?.path ?? []));

  for (let i = 0; i < 64; i++) {
    const cell = cells[i];
    const pieceId = state.board[i];

    cell.className = "cell";
    if (((i >> 3) + (i & 7)) % 2 === 1) cell.classList.add("odd");
    if (CENTER_HOLES.has(i)) cell.classList.add("center");

    cell.innerHTML = pieceId >= 0 ? '<span class="piece"></span>' : "";
    cell.title = pieceId >= 0 ? `หมาก #${pieceId} · ${squareLabel(i)}` : squareLabel(i);

    if (state.selection && i === state.selection.at) cell.classList.add("selected");
    if (path.has(i)) cell.classList.add("path");
    if (eaten.has(i)) cell.classList.add("eaten");
    if (trail.has(i)) cell.classList.add("trail");
    // server ส่ง selectable เป็นค่าว่างอยู่แล้วเมื่อกำลังอยู่กลาง chain
    if (targets.has(i)) cell.classList.add("target", state.targetKind);
    else if (selectable.has(i)) cell.classList.add("selectable");
  }
}

/**
 * การจบเกมต้องได้เสียงครบทุกคนที่ยังเล่นอยู่ หน้าจอจึงต้องบอกให้ชัดว่า
 * กำลังโหวตอยู่ ใครโหวตแล้ว และเหลืออีกกี่เสียง ไม่ใช่กดแล้วเงียบ
 */
function renderEndOffer() {
  const state = app.state;
  const active = state && app.match && state.status === "active";
  const offering = active && state.endOfferBy !== null;

  el.offerEnd.classList.toggle("hidden", !active || offering);
  el.endOffer.classList.toggle("hidden", !offering);
  if (!offering) return;

  const mine = state.endOfferBy === app.match.you;
  const tally = `${state.endVotes.length}/${state.endVotesNeeded}`;
  $("end-offer-text").textContent = mine
    ? `คุณขอจบเกม — รอโหวตจากผู้เล่นอื่น (${tally})`
    : `${playerName(state.players[state.endOfferBy])} ขอจบเกม (${tally}) — คุณจะจบด้วยไหม`;

  // คนที่โหวตไปแล้วไม่ต้องเห็นปุ่มโหวตซ้ำ
  const voted = mine || state.endVotes.includes(app.match.you);
  $("end-offer-vote").classList.toggle("hidden", voted);
  $("end-offer-waiting").classList.toggle("hidden", !mine);
}

function renderScoreboard() {
  const state = app.state;

  if (el.scoreList.childElementCount !== state.playerCount) {
    el.scoreList.innerHTML = "";
    for (let seat = 0; seat < state.playerCount; seat++) {
      const side = document.createElement("div");
      side.className = "side";
      side.innerHTML = '<span class="pname"></span><span class="pscore">0</span>';
      el.scoreList.appendChild(side);
    }
  }

  for (let seat = 0; seat < state.playerCount; seat++) {
    const side = el.scoreList.children[seat];
    const player = state.players[seat] ?? { name: "?", connected: false };
    const label = playerName(player) + (app.match && seat === app.match.you ? " (คุณ)" : "");
    const auto = state.autopilot.includes(seat);
    side.querySelector(".pname").innerHTML =
      escapeHtml(label) + (auto && !player.bot ? '<span class="bot-tag">AI คุมแทน</span>' : "");
    side.querySelector(".pscore").textContent = String(state.scores[seat] ?? 0);
    side.classList.toggle("active", state.current === seat && state.status === "active");
    side.classList.toggle("retired", state.retired.includes(seat));
    side.classList.toggle("gone", !player.connected && !state.retired.includes(seat));
    side.classList.toggle("auto", state.autopilot.includes(seat));
  }

  el.turnNo.textContent = `Turn ${state.turn}`;

  const yourTurn = app.match && state.current === app.match.you;
  el.gameStatus.classList.toggle("your-turn", Boolean(yourTurn));
  if (state.status !== "active") {
    el.gameStatus.textContent = "เกมจบแล้ว";
  } else if (!yourTurn) {
    el.gameStatus.textContent = `รอ ${playerName(state.players[state.current])} เดิน`;
  } else if (app.match && state.autopilot.includes(app.match.you)) {
    el.gameStatus.textContent = "AI กำลังคุมที่นั่งของคุณ — คลิกหมากเพื่อกลับมาเล่นเอง";
  } else if (!state.selection) {
    el.gameStatus.textContent = "ตาคุณ — เลือกหมากตัวไหนก็ได้บนกระดาน";
  } else if (state.targetKind === "capture") {
    el.gameStatus.textContent = "เลือกช่องลง (ต้องเดินเส้นทางที่กินได้มากที่สุด)";
  } else if (state.targetKind === "move") {
    el.gameStatus.textContent = "หมากตัวนี้กินไม่ได้ — เลือกช่องที่จะขยับไป";
  } else if (state.canEndTurn) {
    el.gameStatus.textContent = "ยังกินต่อได้ — หาช่องต่อไป หรือกดจบเทิร์นเพื่อหยุดแค่นี้";
  } else {
    el.gameStatus.textContent = "วางหมากลงช่องที่ต้องการ (กินหรือเดินก็ได้)";
  }

  const selection = state.selection;
  const inChain = Boolean(selection && selection.capturesSoFar > 0);
  el.chainBar.classList.toggle("hidden", !inChain);
  if (inChain) {
    // บอกเป้าหมายเต็มได้เฉพาะโหมดที่ช่วยคำนวณ ไม่งั้นก็เท่ากับเฉลยให้
    el.chainBar.textContent =
      selection.availableCaptures !== null
        ? `หมาก #${selection.pieceId} · กินแล้ว ${selection.capturesSoFar}/${selection.availableCaptures}`
        : `หมาก #${selection.pieceId} · กินแล้ว ${selection.capturesSoFar} ตัว`;
  }
  const yourMove = Boolean(app.match && state.current === app.match.you && state.status === "active");
  el.cancelSelect.classList.toggle(
    "hidden",
    !(yourMove && selection && selection.capturesSoFar === 0 && !state.rules.touchMove),
  );
  el.endTurn.classList.toggle("hidden", !(yourMove && state.canEndTurn));

  // เตือนเมื่อใกล้จบเกมเพราะไม่มีการกิน (แต่ไม่ทับข้อความ chain ที่กำลังเดินอยู่)
  if (!inChain && state.status === "active" && state.noCaptureLimit - state.noCaptureStreak <= 5) {
    el.chainBar.classList.remove("hidden");
    el.chainBar.textContent = `ไม่มีการกินมา ${state.noCaptureStreak} เทิร์นติดกัน — ครบ ${state.noCaptureLimit} เทิร์นจะจบเกม`;
  }
}

function renderLog() {
  const state = app.state;
  const wanted = state.turn - 1;
  if (el.log.childElementCount >= wanted) return;
  const last = state.lastTurn;
  if (!last) return;
  el.log.prepend(logRow(last, state.players));
}

function logRow(record, players) {
  const li = document.createElement("li");
  const who = players?.[record.player] ? playerName(players[record.player]) : `Player ${record.player + 1}`;
  const detail =
    record.kind === "capture"
      ? `<span class="cap">กิน ${record.captures}</span> · ${record.path.map(squareLabel).join(" → ")}`
      : `เดิน ${record.path.map(squareLabel).join(" → ")}`;
  li.innerHTML = `<span class="t">#${record.turn}</span><span>${escapeHtml(who)} · หมาก #${record.pieceId} · ${detail}</span>`;
  return li;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ── นาฬิกาเทิร์น ────────────────────────────────────────────────────────────

setInterval(() => {
  const state = app.state;
  if (!state || state.status !== "active" || !state.deadline) {
    el.timer.textContent = !state ? "–" : state.turnSeconds > 0 ? "–" : "∞";
    el.timer.classList.remove("warn");
    return;
  }
  const left = Math.max(0, state.deadline + app.clockSkew - Date.now());
  const seconds = Math.ceil(left / 1000);
  el.timer.textContent = `${seconds}s`;
  el.timer.classList.toggle("warn", seconds <= 10);
}, 200);

// ── หน้าจอ ──────────────────────────────────────────────────────────────────

function showScreen(name) {
  for (const [key, node] of Object.entries(el.screens)) node.classList.toggle("hidden", key !== name);
}

function renderFriends(message) {
  el.friendsCard.classList.toggle("hidden", !app.user);
  el.friendRequests.innerHTML = "";
  el.friendsList.innerHTML = "";

  for (const request of message.incoming) {
    const li = document.createElement("li");
    const info = document.createElement("span");
    info.innerHTML = `<span class="request-label">คำขอเป็นเพื่อน</span><br>${escapeHtml(request.player.name)}`;
    const actions = document.createElement("span");
    actions.className = "friend-actions";
    actions.append(
      friendButton("รับ", "small primary", () =>
        send({ type: "friend_respond", requestId: request.requestId, accept: true }),
      ),
      friendButton("ปฏิเสธ", "small ghost", () =>
        send({ type: "friend_respond", requestId: request.requestId, accept: false }),
      ),
    );
    li.append(info, actions);
    el.friendRequests.appendChild(li);
  }

  for (const request of message.outgoing) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(request.player.name)}</span><span class="muted">รอตอบรับ</span>`;
    el.friendRequests.appendChild(li);
  }

  if (message.friends.length === 0 && message.incoming.length === 0 && message.outgoing.length === 0) {
    const li = document.createElement("li");
    li.textContent = "ยังไม่มีเพื่อน — เพิ่มด้วยชื่อผู้ใช้หรืออีเมลด้านบน";
    el.friendsList.appendChild(li);
    return;
  }

  for (const friend of message.friends) {
    const li = document.createElement("li");
    const info = document.createElement("span");
    info.className = "friend";
    info.innerHTML =
      `<span class="dot${friend.online ? " online" : ""}"></span>` +
      `<span>${escapeHtml(friend.name)} <span class="rating">${friend.rating}</span></span>`;

    const actions = document.createElement("span");
    actions.className = "friend-actions";
    // ชวนเข้าห้องได้เฉพาะตอนที่เราอยู่ในห้องอยู่แล้ว
    if (app.room) {
      actions.appendChild(
        friendButton("ชวนเข้าห้อง", "small primary", () => send({ type: "invite_to_room", targetId: friend.id })),
      );
    } else if (friend.online) {
      actions.appendChild(
        friendButton("ท้าดวล", "small", () => send({ type: "challenge", targetId: friend.id })),
      );
    }
    actions.appendChild(friendButton("ลบ", "small ghost", () => send({ type: "friend_remove", playerId: friend.id })));

    li.append(info, actions);
    el.friendsList.appendChild(li);
  }
}

function friendButton(label, className, onClick) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderPlayers(players) {
  el.playersCard.classList.remove("hidden");
  el.playersList.innerHTML = "";
  if (players.length === 0) {
    const li = document.createElement("li");
    li.textContent = "ยังไม่มีผู้เล่นอื่นที่ว่างอยู่ — ลองใช้ Create Room แล้วส่งลิงก์เชิญ";
    el.playersList.appendChild(li);
    return;
  }
  for (const player of players) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = player.name;
    const button = document.createElement("button");
    button.className = "small";
    button.textContent = "Challenge";
    button.addEventListener("click", () => send({ type: "challenge", targetId: player.id }));
    li.append(name, button);
    el.playersList.appendChild(li);
  }
}

function renderRoom() {
  const room = app.room;
  el.roomCode.textContent = room.code;
  el.roomMeta.textContent =
    `${room.visibility === "public" ? "ห้อง Public" : "ห้อง Private"} · ` +
    `${room.players.length}/${room.capacity} คน · ` +
    (room.turnSeconds > 0 ? `${room.turnSeconds} วินาทีต่อเทิร์น` : "ไม่จำกัดเวลา") +
    ` · กติกา${MODE_NAMES[room.mode] ?? room.mode}`;

  const isHost = app.session?.id === room.hostId;

  el.roomPlayers.innerHTML = "";
  for (const player of room.players) {
    const span = document.createElement("span");
    span.textContent = playerName(player) + (player.id === room.hostId ? " · เจ้าของห้อง" : "");
    // เจ้าของห้องเอา AI ออกได้ แต่เตะคนจริงไม่ได้
    if (player.bot && isHost) {
      const kick = document.createElement("button");
      kick.className = "kick";
      kick.textContent = "✕";
      kick.title = `เอา ${playerName(player)} ออก`;
      kick.addEventListener("click", () => send({ type: "remove_bot", playerId: player.id }));
      span.appendChild(kick);
    }
    el.roomPlayers.appendChild(span);
  }

  $("bot-controls").classList.toggle("hidden", !isHost || room.players.length >= room.capacity);
  const canStart = room.players.length >= 2;
  el.startRoom.disabled = !isHost || !canStart;
  // บอกไว้ก่อนเริ่ม จะได้ไม่มีใครคิดว่าเจ้าของห้องได้เปรียบเพราะได้เดินก่อนเสมอ
  const orderHint = " · ลำดับการเดินสุ่มตอนเริ่มเกม";
  el.roomStatus.textContent =
    (canStart
      ? isHost
        ? room.players.length < room.capacity
          ? `เริ่มได้เลย หรือรออีก ${room.capacity - room.players.length} คน`
          : "ครบแล้ว กด Start เพื่อเริ่มเกม"
        : "รอเจ้าของห้องกด Start"
      : `ผู้เล่น ${room.players.length} / ${room.capacity} — ส่งรหัสหรือลิงก์ให้เพื่อนเข้ามา`) + orderHint;
}

function renderRooms(rooms) {
  el.roomsList.innerHTML = "";
  if (rooms.length === 0) {
    const li = document.createElement("li");
    li.textContent = "ยังไม่มีห้อง Public ที่เปิดอยู่ — สร้างห้องแล้วตั้งเป็น Public ได้เลย";
    el.roomsList.appendChild(li);
    return;
  }
  for (const room of rooms) {
    const li = document.createElement("li");
    const info = document.createElement("span");
    info.textContent =
      `${room.hostName} · ${room.players}/${room.capacity} คน · ` +
      (room.turnSeconds > 0 ? `${room.turnSeconds} วิ/เทิร์น` : "ไม่จำกัดเวลา") +
      (room.bots > 0 ? ` · AI ${room.bots}` : "") +
      ` · ${MODE_NAMES[room.mode] ?? room.mode}`;
    const button = document.createElement("button");
    button.className = "small";
    button.textContent = "เข้าร่วม";
    button.addEventListener("click", () => send({ type: "join_room", code: room.id }));
    li.append(info, button);
    el.roomsList.appendChild(li);
  }
}

function renderResult(message) {
  const { result, stats, players, history } = message;
  const you = app.match?.you ?? 0;
  const winners = result.winners ?? [];

  el.resultTitle.textContent =
    winners.length === 0
      ? "จบเกม"
      : winners.includes(you)
        ? winners.length > 1 ? "คุณชนะร่วม" : "คุณชนะ"
        : winners.length > 1
          ? `เสมอ: ${winners.map((seat) => playerName(players[seat])).join(" · ")}`
          : `${playerName(players[winners[0]])} ชนะ`;

  el.resultScores.innerHTML = "";
  for (let seat = 0; seat < result.scores.length; seat++) {
    const div = document.createElement("div");
    div.className = winners.includes(seat) ? "win" : "";
    div.innerHTML = `<b>${result.scores[seat]}</b>${escapeHtml(playerName(players[seat]))}`;
    el.resultScores.appendChild(div);
  }

  el.resultReason.textContent = {
    no_legal_moves: "จบเพราะไม่มีการเล่นที่ถูกต้องเหลือ",
    exhaustion: "จบเพราะไม่มีการกินติดต่อกันจนครบลิมิต",
    agreement: "จบเพราะทั้งสองฝ่ายตกลงจบเกม",
    resign: "จบเพราะมีผู้ยอมแพ้",
    timeout: "จบเพราะมีผู้เล่นหายไปนานเกินไป",
  }[result.reason] ?? "";

  const rows = [
    ["คะแนนรวม", (s) => s.score],
    ["จำนวนที่กินได้", (s) => s.captures],
    ["จำนวนเทิร์น", (s) => s.turns],
    ["Chain สูงสุด", (s) => s.bestChain],
    ["Chain ที่ดีที่สุด (เทิร์น)", (s) => (s.bestChainTurn ? `#${s.bestChainTurn}` : "–")],
    ["คะแนนที่ปล่อยหลุดมือ", (s) => s.missedCaptures],
    ["เทิร์นที่พลาดโอกาส", (s) => s.missedTurns],
    ["พลาดหนักสุด", (s) => (s.worstMiss ? `${s.worstMiss.missed} ตัว (เทิร์น #${s.worstMiss.turn})` : "–")],
  ];
  const head = stats.players.map((_, seat) => `<th>${escapeHtml(playerName(players[seat]))}</th>`).join("");
  el.resultStats.innerHTML =
    `<tr><th></th>${head}</tr>` +
    rows
      .map(([label, pick]) => `<tr><td>${label}</td>${stats.players.map((p) => `<td>${pick(p)}</td>`).join("")}</tr>`)
      .join("") +
    `<tr><td>หมากที่เหลือบนกระดาน</td><td colspan="${stats.players.length}">${stats.piecesLeft}</td></tr>`;

  el.resultHistory.innerHTML = "";
  for (const record of [...history].reverse()) el.resultHistory.appendChild(logRow(record, players));
}

function toast(text, isError = false) {
  const node = document.createElement("div");
  node.className = `toast${isError ? " error" : ""}`;
  node.textContent = text;
  el.toasts.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

// ── วิธีเล่น ────────────────────────────────────────────────────────────────

/**
 * แผนภาพกระดานย่อ วาดจากสตริงสั้น ๆ เพื่อไม่ต้องเขียน div เป็นสิบ ๆ ตัวใน HTML
 *   A = หมากที่กำลังเล่น · o = หมากอื่น · x = หมากที่กำลังจะถูกกิน
 *   * = ช่องที่ลงได้ · . = ช่องว่าง
 */
const HELP_DIAGRAMS = {
  "capture-before": ["Ax*"],
  "capture-after": ["..A"],
  directions: ["*.*.*", ".ooo.", "*oAo*", ".ooo.", "*.*.*"],
  "chain-1": ["Ax.o."],
  "chain-2": ["..Ax."],
  "chain-3": ["....A"],
  move: ["***", "*A*", "***"],
};

function renderDiagram(node, rows) {
  node.style.gridTemplateColumns = `repeat(${rows[0].length}, 22px)`;
  node.innerHTML = "";
  rows.forEach((row, r) => {
    [...row].forEach((symbol, c) => {
      const cell = document.createElement("span");
      cell.className = "mc" + ((r + c) % 2 === 1 ? " odd" : "");
      if (symbol === "A") cell.classList.add("actor");
      if (symbol === "x") cell.classList.add("prey");
      if (symbol === "*") cell.classList.add("spot");
      if (symbol === "A" || symbol === "o" || symbol === "x") {
        cell.innerHTML = '<span class="piece"></span>';
      }
      node.appendChild(cell);
    });
  });
}

function buildHelpDiagrams() {
  for (const node of document.querySelectorAll("[data-mini]")) {
    const rows = HELP_DIAGRAMS[node.dataset.mini];
    if (rows) renderDiagram(node, rows);
  }
}

const MODE_RULES = {
  assisted: { forceMaximum: true, assist: "full" },
  standard: { forceMaximum: false, assist: "pieces" },
  table: { forceMaximum: false, assist: "none" },
};

function openHelp() {
  // ถ้ากำลังอยู่ในเกม ให้ชี้ว่าห้องนี้ใช้โหมดไหน กติกาจะได้ตรงกับที่เห็นตรงหน้า
  const active = app.state?.rules;
  for (const row of el.helpModes.querySelectorAll("tr[data-mode]")) {
    const rules = MODE_RULES[row.dataset.mode];
    row.classList.toggle(
      "current",
      Boolean(active && rules && rules.forceMaximum === active.forceMaximum && rules.assist === active.assist),
    );
  }
  el.helpModal.classList.remove("hidden");
  $("help-close").focus();
}

function closeHelp() {
  el.helpModal.classList.add("hidden");
}

for (const button of document.querySelectorAll("[data-help]")) {
  button.addEventListener("click", openHelp);
}
$("help-close").addEventListener("click", closeHelp);
$("help-done").addEventListener("click", closeHelp);
el.helpModal.addEventListener("click", (event) => {
  if (event.target === el.helpModal) closeHelp();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.helpModal.classList.contains("hidden")) closeHelp();
});

// ── ปุ่มต่าง ๆ ───────────────────────────────────────────────────────────────

el.nameInput.addEventListener("change", () => {
  const name = el.nameInput.value.trim();
  if (!name) return;
  localStorage.setItem(NAME_KEY, name);
  send({ type: "set_name", name });
});

$("btn-quick").addEventListener("click", () => send({ type: "quick_match" }));
$("btn-cancel-queue").addEventListener("click", () => send({ type: "cancel_quick_match" }));
$("btn-create-room").addEventListener("click", () =>
  send({
    type: "create_room",
    turnSeconds: chosenTurnSeconds(),
    capacity: Number(el.roomCapacity.value),
    visibility: el.roomVisibility.value,
    mode: el.roomMode.value,
  }),
);
$("btn-refresh-rooms").addEventListener("click", () => send({ type: "list_rooms" }));
$("btn-refresh-leaderboard").addEventListener("click", refreshLeaderboard);
$("btn-refresh-friends").addEventListener("click", () => send({ type: "list_friends" }));
$("friend-add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("friend-identifier");
  const identifier = input.value.trim();
  if (!identifier) return;
  send({ type: "friend_request", identifier });
  input.value = "";
});
$("btn-accept-invite").addEventListener("click", () => {
  if (app.invite) send({ type: "join_room", code: app.invite.code });
  el.inviteModal.classList.add("hidden");
});
$("btn-decline-invite").addEventListener("click", () => {
  app.invite = null;
  el.inviteModal.classList.add("hidden");
});
$("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("/api/v1/auth/login");
});
$("btn-register").addEventListener("click", () => submitAuth("/api/v1/auth/register"));
$("btn-verify-otp").addEventListener("click", submitOtp);
$("btn-resend-otp").addEventListener("click", async () => {
  el.otpError.textContent = "";
  try {
    await api("/api/v1/auth/resend-otp", {
      method: "POST",
      body: JSON.stringify({ email: app.user?.email, locale: preferredLocale() }),
    });
    toast("ส่งรหัสใหม่แล้ว");
  } catch (error) {
    el.otpError.textContent = error.message;
  }
});
$("btn-logout").addEventListener("click", () => {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(TOKEN_KEY);
  app.user = null;
  renderUser();
  app.socket?.close();
});

for (const button of document.querySelectorAll("[data-ai]")) {
  button.addEventListener("click", () =>
    send({ type: "play_ai", level: button.dataset.ai, turnSeconds: chosenTurnSeconds(), mode: el.roomMode.value }),
  );
}
$("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code) send({ type: "join_room", code });
});
$("btn-challenge").addEventListener("click", () => send({ type: "list_players" }));
$("btn-refresh-players").addEventListener("click", () => send({ type: "list_players" }));

$("btn-copy-invite").addEventListener("click", async () => {
  if (!app.room) return;
  try {
    await navigator.clipboard.writeText(app.room.inviteUrl);
    toast("คัดลอกลิงก์เชิญแล้ว");
  } catch {
    toast(app.room.inviteUrl);
  }
});
for (const button of document.querySelectorAll("[data-add-bot]")) {
  button.addEventListener("click", () => send({ type: "add_bot", level: button.dataset.addBot }));
}
el.startRoom.addEventListener("click", () => send({ type: "start_room" }));
$("btn-leave-room").addEventListener("click", () => {
  send({ type: "leave_room" });
  showScreen("lobby");
});

el.cancelSelect.addEventListener("click", () => send({ type: "cancel_select" }));
el.endTurn.addEventListener("click", () => send({ type: "end_turn" }));
$("btn-offer-end").addEventListener("click", () => send({ type: "offer_end" }));
$("btn-resign").addEventListener("click", () => send({ type: "resign" }));
$("btn-accept-end").addEventListener("click", () => send({ type: "respond_end", accept: true }));
$("btn-decline-end").addEventListener("click", () => send({ type: "respond_end", accept: false }));
// ผู้เสนอถอนคำขอเองได้ ใช้ช่องทางเดียวกัน server รู้จากที่นั่งว่าเป็นการถอน
$("btn-cancel-end").addEventListener("click", () => send({ type: "respond_end", accept: false }));

$("btn-rematch").addEventListener("click", () => send({ type: "rematch" }));
$("btn-back-lobby").addEventListener("click", () => {
  // กลับ lobby แล้วไม่ต้องผูกกับ node ของแมตช์เดิมอีก
  sessionStorage.removeItem(NODE_KEY);
  send({ type: "leave_match" });
  app.match = null;
  app.state = null;
  showScreen("lobby");
});

$("btn-accept-challenge").addEventListener("click", () => {
  if (app.incomingChallenge) send({ type: "challenge_respond", challengeId: app.incomingChallenge.id, accept: true });
  el.challengeModal.classList.add("hidden");
});
$("btn-decline-challenge").addEventListener("click", () => {
  if (app.incomingChallenge) send({ type: "challenge_respond", challengeId: app.incomingChallenge.id, accept: false });
  el.challengeModal.classList.add("hidden");
});

// ── เริ่มทำงาน ──────────────────────────────────────────────────────────────

const inviteMatch = location.pathname.match(/^\/join\/([A-Za-z0-9]{4,10})$/);
if (inviteMatch) {
  app.pendingJoinCode = inviteMatch[1].toUpperCase();
  history.replaceState(null, "", "/");
}

buildBoard();
buildHelpDiagrams();
connect();

loadMessages(preferredLocale())
  .then(() => api("/api/v1/config"))
  .then(async (config) => {
    app.accountsEnabled = Boolean(config.accounts);
    if (config.protocolVersion && config.protocolVersion !== PROTOCOL_VERSION) {
      toast("เวอร์ชันเซิร์ฟเวอร์ไม่ตรงกับหน้าเว็บ ลองรีเฟรชหน้านี้", true);
    }
    renderUser();
    if (config.google) setupGoogle(config.googleClientId);
    await refreshUser();
    await refreshLeaderboard();
  })
  .catch(() => {});

// เปิดวิธีเล่นให้อัตโนมัติครั้งแรกที่เข้ามา เพราะกติกาเกมนี้ไม่เหมือนหมากทั่วไป
if (!localStorage.getItem(SEEN_HELP_KEY)) {
  localStorage.setItem(SEEN_HELP_KEY, "1");
  openHelp();
}
