/**
 * รหัสข้อผิดพลาดของ engine
 *
 * engine ไม่ผลิตข้อความให้มนุษย์อ่าน เพราะมันไม่รู้ว่าใครจะเอาไปแสดงและด้วยภาษาอะไร
 * มันบอกแค่ว่า "อะไรผิด" ส่วน "จะพูดว่าอย่างไร" เป็นหน้าที่ของ client
 */
export type GameErrorCode =
  | "game_ended"
  | "must_finish_chain"
  | "empty_square"
  | "piece_stuck"
  | "already_acted"
  | "touch_move"
  | "no_piece_selected"
  | "piece_cannot_capture"
  | "no_more_captures"
  | "must_take_maximum"
  | "illegal_jump"
  | "must_capture"
  | "illegal_move"
  | "nothing_played"
  | "chain_forced"
  | "no_legal_action"
  | "unknown_player"
  | "already_retired";

/** ค่าที่เอาไปเติมในข้อความ เช่น รายชื่อช่องที่ลงได้ */
export type ErrorParams = Record<string, string | number | (string | number)[]>;

export type ActionResult = { ok: true } | { ok: false; code: GameErrorCode; params?: ErrorParams };
