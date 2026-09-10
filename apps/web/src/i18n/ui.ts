/**
 * ข้อความของหน้าเว็บเอง
 *
 * แยกจากแคตตาล็อกของเซิร์ฟเวอร์ตั้งใจ — แคตตาล็อกฝั่งเซิร์ฟเวอร์มีไว้แปล "สิ่งที่
 * เซิร์ฟเวอร์บอก" (ข้อผิดพลาด เหตุการณ์ในเกม) ส่วนป้ายปุ่มและหัวข้อเป็นเรื่องของ
 * หน้าจอนี้ล้วน ๆ เซิร์ฟเวอร์ไม่ควรต้องรู้จัก
 */

import { preferredLocale } from "./messages";

type Dictionary = Record<string, { th: string; en: string }>;

const UI: Dictionary = {
  appTagline: {
    th: "เกมกระดานออนไลน์ เล่นกับเพื่อนได้เลยตอนนี้",
    en: "Online board games — play with friends right now",
  },
  appIntro: {
    th: "เล่นฟรีบนเบราว์เซอร์ แชร์ลิงก์ กระโดดเข้าห้อง แล้วเริ่มเล่นได้เลย ไม่ต้องสมัคร",
    en: "Free in your browser. Share a link, hop into a room, start playing. No signup.",
  },
  playingNow: { th: "กำลังเล่นอยู่ {count} คน", en: "{count} playing now" },
  inQueue: { th: "รอจับคู่ {count} คน", en: "{count} in queue" },
  chooseGame: { th: "เลือกเกม", en: "Choose a game" },
  openRooms: { th: "ห้องที่เปิดอยู่", en: "Open rooms" },
  noRooms: { th: "ยังไม่มีห้องเปิดอยู่ — สร้างห้องแล้วชวนเพื่อนได้เลย", en: "No open rooms yet — create one and invite a friend" },
  refresh: { th: "รีเฟรช", en: "Refresh" },
  join: { th: "เข้าร่วม", en: "Join" },
  back: { th: "ย้อนกลับ", en: "Back" },
  yourName: { th: "ชื่อของคุณ", en: "Your name" },

  playOnline: { th: "เล่นออนไลน์", en: "Play online" },
  playBot: { th: "เล่นกับบอท", en: "Play a bot" },
  createRoom: { th: "สร้างห้อง", en: "Create room" },
  joinByCode: { th: "เข้าร่วมด้วยรหัส", en: "Join with a code" },
  searching: { th: "กำลังหาคู่แข่ง…", en: "Looking for an opponent…" },
  cancel: { th: "ยกเลิก", en: "Cancel" },
  roomCode: { th: "รหัสห้อง", en: "Room code" },

  visibility: { th: "การมองเห็น", en: "Visibility" },
  public: { th: "สาธารณะ", en: "Public" },
  private: { th: "ส่วนตัว", en: "Private" },
  botCount: { th: "จำนวนบอท", en: "Number of bots" },
  botLevel: { th: "ระดับบอท", en: "Bot level" },
  advanced: { th: "ขั้นสูง", en: "Advanced" },
  turnLimit: { th: "จำกัดเวลา (วินาที)", en: "Turn limit (seconds)" },
  maxPlayers: { th: "ผู้เล่นสูงสุด", en: "Max players" },
  ruleMode: { th: "กติกา", en: "Rules" },
  noLimit: { th: "ไม่จำกัด", en: "No limit" },
  customUnranked: {
    th: "ตั้งค่าเองแล้วเกมนี้จะไม่นับคะแนนอันดับ",
    en: "Custom settings mean this game will not count towards ranking",
  },
  create: { th: "สร้าง", en: "Create" },

  waitingHost: { th: "รอเจ้าของห้องกดเริ่ม", en: "Waiting for the host to start" },
  readyToStart: { th: "พร้อมแล้ว กดเริ่มได้เลย", en: "Ready — start whenever you like" },
  waitingPlayers: { th: "ผู้เล่น {players} / {capacity} — ส่งรหัสหรือลิงก์ให้เพื่อน", en: "Players {players} / {capacity} — share the code or link" },
  orderRandom: { th: "ลำดับการเดินสุ่มตอนเริ่มเกม", en: "Turn order is randomised at the start" },
  start: { th: "เริ่มเกม", en: "Start" },
  leaveRoom: { th: "ออกจากห้อง", en: "Leave room" },
  addBot: { th: "เพิ่มบอท", en: "Add bot" },
  inviteSlot: { th: "ชวนเพื่อน", en: "Invite a friend" },
  copyLink: { th: "คัดลอกลิงก์เชิญ", en: "Copy invite link" },
  copied: { th: "คัดลอกแล้ว", en: "Copied" },
  host: { th: "เจ้าของห้อง", en: "Host" },

  yourTurn: { th: "ตาคุณ — เลือกหมากตัวไหนก็ได้บนกระดาน", en: "Your turn — pick any piece on the board" },
  waitingFor: { th: "รอ {name} เดิน", en: "Waiting for {name}" },
  pickTarget: { th: "เลือกช่องลง (ต้องเดินเส้นทางที่กินได้มากที่สุด)", en: "Choose where to land (longest capture chain required)" },
  pickMove: { th: "หมากตัวนี้กินไม่ได้ — เลือกช่องที่จะขยับไป", en: "This piece cannot capture — choose where to move" },
  chainOrStop: { th: "ยังกินต่อได้ — หาช่องต่อไป หรือกดจบเทิร์น", en: "You can keep capturing — find the next jump or end your turn" },
  placePiece: { th: "วางหมากลงช่องที่ต้องการ", en: "Place the piece where you want it" },
  autopilotYours: { th: "AI กำลังคุมที่นั่งของคุณ — คลิกหมากเพื่อกลับมาเล่นเอง", en: "AI is playing your seat — click a piece to take over" },
  gameOver: { th: "เกมจบแล้ว", en: "Game over" },
  chainProgress: { th: "กินแล้ว {captured} ตัว", en: "{captured} captured" },
  chainProgressOf: { th: "กินแล้ว {captured}/{total}", en: "{captured}/{total} captured" },
  nearExhaustion: {
    th: "ไม่มีการกินมา {streak} เทิร์นติดกัน — ครบ {limit} เทิร์นจะจบเกม",
    en: "{streak} turns without a capture — the game ends at {limit}",
  },
  endTurn: { th: "จบเทิร์น", en: "End turn" },
  cancelSelect: { th: "ยกเลิกการเลือก", en: "Cancel selection" },
  offerEnd: { th: "ขอจบเกม", en: "Offer to end" },
  resign: { th: "ยอมแพ้", en: "Resign" },
  youOfferedEnd: { th: "คุณขอจบเกม — รอโหวตจากผู้เล่นอื่น ({votes})", en: "You asked to end — waiting for votes ({votes})" },
  theyOfferedEnd: { th: "{name} ขอจบเกม ({votes}) — คุณจะจบด้วยไหม", en: "{name} asked to end ({votes}) — do you agree?" },
  accept: { th: "ยอมรับ", en: "Accept" },
  keepPlaying: { th: "เล่นต่อ", en: "Keep playing" },
  withdraw: { th: "ถอนคำขอ", en: "Withdraw" },
  unranked: { th: "เกมนี้ไม่นับอันดับ", en: "Unranked game" },

  youWin: { th: "คุณชนะ", en: "You win" },
  youWinShared: { th: "คุณชนะร่วม", en: "You share the win" },
  winnerIs: { th: "{name} ชนะ", en: "{name} wins" },
  draw: { th: "เสมอ: {names}", en: "Draw: {names}" },
  playAgain: { th: "เล่นอีกครั้ง", en: "Play again" },
  backToLobby: { th: "กลับหน้าเกม", en: "Back to lobby" },
  waitingRematch: { th: "รออีกฝ่ายตอบรับ…", en: "Waiting for the other player…" },
  statScore: { th: "คะแนนรวม", en: "Score" },
  statCaptures: { th: "จำนวนที่กินได้", en: "Captures" },
  statTurns: { th: "จำนวนเทิร์น", en: "Turns" },
  statBestChain: { th: "chain สูงสุด", en: "Best chain" },
  statMissed: { th: "คะแนนที่ปล่อยหลุดมือ", en: "Points left on the table" },
  piecesLeft: { th: "หมากที่เหลือบนกระดาน", en: "Pieces left" },

  inviteTitle: { th: "{name} ชวนคุณเข้าห้อง", en: "{name} invited you to a room" },
  later: { th: "ไว้ก่อน", en: "Later" },
  howToPlay: { th: "วิธีเล่น", en: "How to play" },

  signInPrompt: {
    th: "มีบัญชีแล้ว หรืออยากเก็บอันดับ? เข้าสู่ระบบ / สมัคร",
    en: "Have an account, or want a ranking? Sign in or sign up",
  },
  emailOrUsername: { th: "อีเมลหรือชื่อผู้ใช้", en: "Email or username" },
  password: { th: "รหัสผ่าน", en: "Password" },
  signIn: { th: "เข้าสู่ระบบ", en: "Sign in" },
  signUp: { th: "สมัครใหม่", en: "Sign up" },
  signOut: { th: "ออกจากระบบ", en: "Sign out" },
  record: {
    th: "ชนะ {wins} · แพ้ {losses} · เสมอ {draws} · เล่นแล้ว {games} เกม",
    en: "{wins}W · {losses}L · {draws}D · {games} games",
  },
  unverifiedNote: {
    th: "ยังไม่ได้ยืนยันอีเมล เกมของคุณจะยังไม่นับอันดับ",
    en: "Email not verified yet, so your games will not count towards ranking",
  },

  leaderboard: { th: "อันดับผู้เล่น", en: "Leaderboard" },
  noRanked: {
    th: "ยังไม่มีใครติดอันดับ เล่นแมตช์ที่ทุกคนล็อกอินเพื่อเก็บอันดับ",
    en: "Nobody ranked yet — play a match where everyone is signed in",
  },
  rankedNote: {
    th: "นับเฉพาะแมตช์ที่ทุกที่นั่งเป็นบัญชีที่ยืนยันแล้ว ไม่นับเกมที่มีบอทหรือผู้เล่นชั่วคราว",
    en: "Only matches where every seat is a verified account count — not games with bots or guests",
  },

  friends: { th: "เพื่อน", en: "Friends" },
  addFriend: { th: "เพิ่มเพื่อน", en: "Add a friend" },
  friendIdentifier: { th: "ชื่อผู้ใช้หรืออีเมลของเพื่อน", en: "Friend's username or email" },
  add: { th: "เพิ่ม", en: "Add" },
  friendRequest: { th: "คำขอเป็นเพื่อน", en: "Friend request" },
  decline: { th: "ปฏิเสธ", en: "Decline" },
  awaitingReply: { th: "รอตอบรับ", en: "Awaiting reply" },
  noFriends: {
    th: "ยังไม่มีเพื่อน เพิ่มด้วยชื่อผู้ใช้หรืออีเมลด้านบน",
    en: "No friends yet — add one with their username or email above",
  },
  inviteToRoom: { th: "ชวนเข้าห้อง", en: "Invite to room" },
  remove: { th: "ลบ", en: "Remove" },
};

export function ui(key: keyof typeof UI | string, params: Record<string, string | number> = {}): string {
  const entry = UI[key];
  if (!entry) return String(key);
  const locale = preferredLocale();
  const template = locale === "th" ? entry.th : entry.en;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export const modeName = (mode: string): string =>
  ({
    assisted: { th: "ช่วยคำนวณ", en: "Assisted" },
    standard: { th: "มาตรฐาน", en: "Standard" },
    table: { th: "กระดานจริง", en: "Tabletop" },
  })[mode]?.[preferredLocale() === "th" ? "th" : "en"] ?? mode;
