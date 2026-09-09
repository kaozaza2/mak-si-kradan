/**
 * แคตตาล็อกข้อความ
 *
 * โปรโตคอลส่งแค่ `code` กับ `params` — ตัวข้อความไม่ได้อยู่ใน packet เลย
 * client จะแปลเองก็ได้ หรือจะดึงแคตตาล็อกนี้ไปใช้ก็ได้ผ่าน GET /api/v1/messages
 *
 * ข้อดีคือแอปมือถือเลือกภาษาเองได้ client เช็ค error ด้วย code แทนการเทียบสตริง
 * และแก้คำพูดได้โดยไม่ทำให้ client ที่ปล่อยไปแล้วพัง
 */

export type Locale = "th" | "en";
export const LOCALES: Locale[] = ["th", "en"];
export const DEFAULT_LOCALE: Locale = "th";

type Catalog = Record<string, Record<Locale, string>>;

/** `{name}` คือที่เติมค่าจาก params */
export const MESSAGES: Catalog = {
  // ── กติกาจาก engine ────────────────────────────────────────────────────
  game_ended: { th: "เกมจบแล้ว", en: "The game has ended" },
  must_finish_chain: { th: "ต้องกินต่อให้จบ chain ก่อน", en: "Finish the capture chain first" },
  empty_square: { th: "ช่องนี้ไม่มีหมาก", en: "That square is empty" },
  piece_stuck: { th: "หมากตัวนี้กินไม่ได้และขยับไม่ได้", en: "That piece can neither capture nor move" },
  already_acted: { th: "ลงมือไปแล้วในเทิร์นนี้", en: "You have already acted this turn" },
  touch_move: { th: "จับหมากแล้วต้องเดินตัวนี้", en: "Touch-move: you must play the piece you picked up" },
  no_piece_selected: { th: "ยังไม่ได้เลือกหมาก", en: "No piece selected" },
  piece_cannot_capture: { th: "หมากตัวนี้กินไม่ได้", en: "That piece cannot capture" },
  no_more_captures: { th: "ไม่มีการกินต่อจากตำแหน่งนี้", en: "No further captures from here" },
  must_take_maximum: {
    th: "ต้องเลือกเส้นทางที่กินได้มากที่สุด (ลงได้ที่ {squares})",
    en: "You must take the longest capture chain (playable: {squares})",
  },
  illegal_jump: { th: "กระโดดไปช่องนั้นไม่ได้ (ลงได้ที่ {squares})", en: "Illegal jump (playable: {squares})" },
  must_capture: { th: "หมากตัวนี้กินได้ จึงต้องกิน", en: "That piece can capture, so it must" },
  illegal_move: { th: "เดินไปช่องนั้นไม่ได้", en: "That move is not legal" },
  nothing_played: { th: "ยังไม่ได้เดินอะไรเลยในเทิร์นนี้", en: "You have not played anything yet" },
  chain_forced: { th: "โหมดนี้บังคับให้กินต่อจนสุด chain", en: "This mode forces you to finish the chain" },
  no_legal_action: { th: "ไม่มีการเล่นที่ถูกต้อง", en: "No legal action available" },
  unknown_player: { th: "ไม่มีผู้เล่นคนนี้", en: "No such player" },
  already_retired: { th: "ผู้เล่นคนนี้ถอนตัวไปแล้ว", en: "That player already withdrew" },

  // ── โปรโตคอล ───────────────────────────────────────────────────────────
  invalid_message: { th: "ข้อความไม่ถูกต้อง", en: "Malformed message" },
  not_json: { th: "ข้อความไม่ใช่ JSON ที่ถูกต้อง", en: "Message is not valid JSON" },
  no_session: { th: "ยังไม่ได้เริ่ม session (ส่ง hello ก่อน)", en: "No session yet — send hello first" },
  unknown_command: { th: "ไม่รู้จักคำสั่งนี้", en: "Unknown command" },
  server_error: { th: "เซิร์ฟเวอร์ผิดพลาด", en: "Server error" },
  protocol_mismatch: {
    th: "เวอร์ชันไม่ตรงกัน (เซิร์ฟเวอร์ใช้ {server} แต่คุณส่งมา {client}) กรุณาอัปเดตแอป",
    en: "Protocol mismatch (server {server}, client {client}) — please update your app",
  },

  // ── แมตช์ ──────────────────────────────────────────────────────────────
  not_your_turn: { th: "ยังไม่ถึงตาคุณ", en: "It is not your turn" },
  not_in_match: { th: "คุณไม่ได้อยู่ในเกม", en: "You are not in a match" },
  first_player: { th: "{name} ได้เดินก่อน", en: "{name} moves first" },
  turn_timeout_autopilot: {
    th: "หมดเวลาของ {name} — ให้ AI คุมแทนจนกว่าจะกลับมาเล่นเอง",
    en: "{name} ran out of time — AI is taking over until they play again",
  },
  player_left_autopilot: {
    th: "{name} ออกจากเกม — AI คุมที่นั่งแทน",
    en: "{name} left — AI is playing their seat",
  },
  player_resigned: { th: "{name} ยอมแพ้", en: "{name} resigned" },
  player_gone: { th: "{name} หายไปนานเกินไป", en: "{name} was away too long" },
  end_offer_started: { th: "{name} ขอจบเกม", en: "{name} asked to end the game" },
  end_offer_declined: { th: "{name} ขอเล่นต่อ", en: "{name} wants to keep playing" },
  end_offer_cancelled: { th: "{name} ถอนคำขอจบเกมแล้ว", en: "{name} withdrew the request to end" },

  // ── ห้อง ───────────────────────────────────────────────────────────────
  busy: { th: "ต้องออกจากห้อง/เกมปัจจุบันก่อน", en: "Leave your current room or match first" },
  room_not_found: { th: "ไม่พบห้องรหัส {code}", en: "No room with code {code}" },
  room_playing: { th: "ห้องนี้กำลังเล่นอยู่", en: "That room is already playing" },
  room_full: { th: "ห้องเต็มแล้ว", en: "That room is full" },
  room_full_for_bot: { th: "ห้องเต็มแล้ว ต้องเพิ่มจำนวนผู้เล่นก่อน", en: "Room is full — raise the player limit first" },
  already_in_room: { th: "คุณอยู่ในห้องนี้อยู่แล้ว", en: "You are already in this room" },
  not_in_room: { th: "คุณไม่ได้อยู่ในห้อง", en: "You are not in a room" },
  not_room_host: { th: "เฉพาะเจ้าของห้องเท่านั้นที่เริ่มเกมได้", en: "Only the host can start the game" },
  not_room_host_bots: { th: "เฉพาะเจ้าของห้องเท่านั้นที่เพิ่ม AI ได้", en: "Only the host can manage AI players" },
  room_needs_players: { th: "ยังรอผู้เล่นอีกคนอยู่", en: "Waiting for another player" },
  room_closed_host_left: { th: "เจ้าของห้องออกจากห้อง", en: "The host left the room" },
  room_closed_you_left: { th: "ออกจากห้องแล้ว", en: "You left the room" },
  room_closed_disconnected: { th: "ผู้เล่นหลุดการเชื่อมต่อ", en: "You were disconnected" },
  player_left_room: { th: "{name} ออกจากห้อง", en: "{name} left the room" },

  // ── AI ─────────────────────────────────────────────────────────────────
  bad_ai_level: { th: "ระดับ AI ไม่ถูกต้อง", en: "Unknown AI level" },
  bot_not_found: { th: "ไม่พบ AI ตัวนี้ในห้อง", en: "No such AI in this room" },
  cannot_manage_bots: { th: "เอา AI ออกไม่ได้ตอนนี้", en: "Cannot remove AI right now" },

  // ── ท้าดวล ─────────────────────────────────────────────────────────────
  challenge_self: { th: "ท้าตัวเองไม่ได้", en: "You cannot challenge yourself" },
  target_offline: { th: "ผู้เล่นคนนี้ไม่ออนไลน์แล้ว", en: "That player is no longer online" },
  target_busy: { th: "ผู้เล่นคนนี้ไม่ว่าง", en: "That player is busy" },
  challenge_gone: { th: "คำท้านี้ไม่อยู่แล้ว", en: "That challenge is no longer available" },
  challenger_unavailable: { th: "ผู้ท้าไม่พร้อมแล้ว", en: "The challenger is no longer available" },

  // ── ชื่อที่ client เรนเดอร์เอง ──────────────────────────────────────────
  // เซิร์ฟเวอร์ส่ง name เป็นค่าว่างหรือส่งระดับบอทมาดิบ ๆ แล้ว client ประกอบเอง
  departed_player: { th: "ผู้เล่นที่ออกไปแล้ว", en: "Player who left" },
  ai_easy: { th: "AI (ง่าย)", en: "AI (Easy)" },
  ai_normal: { th: "AI (ปานกลาง)", en: "AI (Normal)" },
  ai_hard: { th: "AI (ยาก)", en: "AI (Hard)" },

  // ── อีเมล ──────────────────────────────────────────────────────────────
  otp_email_subject: { th: "รหัสยืนยันหมากสี่กระดาน: {code}", en: "Your Mak Si Kradan code: {code}" },
  otp_email_body: {
    th: "รหัสยืนยันของคุณคือ {code}\n\nรหัสนี้ใช้ได้ภายใน {minutes} นาที และใช้ได้ครั้งเดียว\nถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร บัญชีจะไม่ถูกยืนยัน",
    en: "Your verification code is {code}\n\nIt is valid for {minutes} minutes and can be used once.\nIf you did not request this, you can ignore this email.",
  },

  // ── บัญชีผู้ใช้ (ตอบผ่าน REST) ─────────────────────────────────────────
  unauthorized: { th: "ยังไม่ได้ล็อกอิน", en: "Not signed in" },
  user_not_found: { th: "ไม่พบบัญชีนี้", en: "Account not found" },
  username_taken: { th: "ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว", en: "That username is taken" },
  email_taken: { th: "อีเมลนี้ถูกใช้ไปแล้ว", en: "That email is already registered" },
  invalid_credentials: { th: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", en: "Incorrect username or password" },
  invalid_email: { th: "รูปแบบอีเมลไม่ถูกต้อง", en: "That email address is not valid" },
  invalid_username: { th: "ชื่อผู้ใช้ต้องเป็น a-z, 0-9 หรือ _ ยาว 3–20 ตัว", en: "Username must be a-z, 0-9 or _ and 3–20 characters" },
  weak_password: { th: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", en: "Password must be at least 8 characters" },
  password_too_long: { th: "รหัสผ่านยาวเกินไป", en: "Password is too long" },
  otp_invalid: { th: "รหัสไม่ถูกต้องหรือหมดอายุแล้ว", en: "That code is wrong or has expired" },
  otp_too_many_attempts: { th: "กรอกรหัสผิดหลายครั้งเกินไป ขอรหัสใหม่อีกครั้ง", en: "Too many wrong attempts — request a new code" },
  otp_sent: { th: "ถ้าอีเมลนี้มีบัญชีอยู่ ระบบได้ส่งรหัสไปให้แล้ว", en: "If that email has an account, a code has been sent" },
  verification_sent: { th: "ส่งรหัสยืนยันไปที่อีเมลแล้ว", en: "A verification code has been sent to your email" },
  google_disabled: { th: "เซิร์ฟเวอร์นี้ไม่ได้เปิดล็อกอินด้วย Google", en: "Google sign-in is not enabled on this server" },
  google_invalid: { th: "ตรวจสอบ Google token ไม่ผ่าน", en: "Could not verify that Google token" },
  rate_limited: { th: "ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่", en: "Too many attempts — please wait and try again" },
  history_failed: { th: "อ่านประวัติไม่สำเร็จ", en: "Could not load match history" },
  email_not_found: { th: "ไม่พบบัญชีที่ใช้อีเมลนี้", en: "No account uses that email" },
  email_already_verified: { th: "อีเมลนี้ยืนยันแล้ว", en: "That email is already verified" },

  // ── เพื่อน ─────────────────────────────────────────────────────────────
  accounts_disabled: { th: "เซิร์ฟเวอร์นี้ไม่ได้เปิดระบบบัญชีผู้ใช้", en: "Accounts are not enabled on this server" },
  friends_need_account: { th: "ต้องเข้าสู่ระบบก่อนถึงจะใช้ระบบเพื่อนได้", en: "Sign in to use the friends list" },
  player_not_found: { th: "ไม่พบผู้เล่นคนนี้", en: "No such player" },
  friend_self: { th: "เพิ่มตัวเองเป็นเพื่อนไม่ได้", en: "You cannot add yourself" },
  already_friends: { th: "เป็นเพื่อนกันอยู่แล้ว", en: "You are already friends" },
  friend_request_pending: { th: "ส่งคำขอไปแล้ว รอการตอบรับ", en: "Request already sent — waiting for a reply" },
  friend_request_gone: { th: "คำขอนี้ไม่อยู่แล้ว", en: "That request is no longer available" },
  friend_request_sent: { th: "ส่งคำขอเป็นเพื่อนถึง {name} แล้ว", en: "Friend request sent to {name}" },
  friend_added: { th: "{name} เป็นเพื่อนกับคุณแล้ว", en: "{name} is now your friend" },
  friend_declined: { th: "ปฏิเสธคำขอของ {name} แล้ว", en: "Declined the request from {name}" },
  friend_removed: { th: "ลบเพื่อนแล้ว", en: "Friend removed" },

  // ── ชวนเข้าห้อง ────────────────────────────────────────────────────────
  invite_needs_room: { th: "ต้องอยู่ในห้องก่อนถึงจะชวนคนอื่นได้", en: "Create a room before inviting anyone" },
  invite_sent: { th: "ชวน {name} เข้าห้องแล้ว", en: "Invited {name} to your room" },
  invite_room_full: { th: "ห้องเต็มแล้ว ชวนเพิ่มไม่ได้", en: "The room is full" },
  invite_target_busy: { th: "{name} กำลังอยู่ในเกมหรือห้องอื่น", en: "{name} is in another game or room" },
  invite_target_offline: { th: "{name} ไม่ออนไลน์อยู่", en: "{name} is offline" },
  challenge_became_invite: {
    th: "{name} อยู่คนละเซิร์ฟเวอร์ จึงสร้างห้องและส่งคำเชิญไปแทน",
    en: "{name} is on another server, so a room was created and an invite sent instead",
  },

  // ── หลาย node ──────────────────────────────────────────────────────────
  redirect_match_found: { th: "พบคู่แข่งแล้ว", en: "Opponent found" },
  redirect_room_elsewhere: { th: "ห้อง {code} อยู่อีกเซิร์ฟเวอร์", en: "Room {code} lives on another server" },
};

export function isLocale(value: unknown): value is Locale {
  return value === "th" || value === "en";
}

/** เติม params ลงในข้อความ ใช้ทั้งฝั่ง server (log) และ client ที่ดึงแคตตาล็อกไปใช้ */
export function renderMessage(
  code: string,
  params: Record<string, unknown> = {},
  locale: Locale = DEFAULT_LOCALE,
): string {
  const template = MESSAGES[code]?.[locale] ?? MESSAGES[code]?.[DEFAULT_LOCALE] ?? code;
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = params[key];
    if (value === undefined) return whole;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

/** แคตตาล็อกของภาษาเดียว สำหรับส่งให้ client ไปใช้ */
export function catalogFor(locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, translations] of Object.entries(MESSAGES)) out[code] = translations[locale];
  return out;
}
