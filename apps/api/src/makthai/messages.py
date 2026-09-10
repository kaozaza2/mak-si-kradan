"""แคตตาล็อกข้อความ

โปรโตคอลส่งแค่รหัสกับค่าประกอบ ตัวข้อความไม่ได้อยู่ใน packet เลย
client จะแปลเองก็ได้ หรือจะดึงแคตตาล็อกนี้ไปใช้ก็ได้ผ่าน GET /api/v1/messages

ข้อดีคือแอปมือถือเลือกภาษาเองได้ client เช็คข้อผิดพลาดด้วยรหัสแทนการเทียบสตริง
และแก้คำพูดได้โดยไม่ทำให้ client ที่ปล่อยไปแล้วพัง
"""

from __future__ import annotations

import re
from typing import Any

Locale = str
LOCALES: tuple[Locale, ...] = ("th", "en")
DEFAULT_LOCALE: Locale = "th"

_PLACEHOLDER = re.compile(r"\{(\w+)\}")

#: `{name}` คือที่เติมค่าจากพารามิเตอร์
MESSAGES: dict[str, dict[Locale, str]] = {
    # -- เกมในแพลตฟอร์ม
    "game_mak-si-kradan": {"th": "หมากสี่กระดาน", "en": "Mak Si Kradan"},
    "tagline_mak-si-kradan": {
        "th": "หมากเดียวกัน ใครก็ใช้ได้ แต่คะแนนเป็นของคนกิน",
        "en": "Shared pieces, anyone can move them — but captures are yours alone",
    },
    # -- ชื่อที่หน้าเว็บประกอบเอง
    # เซิร์ฟเวอร์ส่งชื่อบอทเป็นกลางทางภาษา และส่งชื่อว่างเมื่อไม่รู้จักผู้เล่นแล้ว
    "departed_player": {"th": "ผู้เล่นที่ออกไปแล้ว", "en": "Player who left"},
    "ai_easy": {"th": "AI (ง่าย)", "en": "AI (Easy)"},
    "ai_normal": {"th": "AI (ปานกลาง)", "en": "AI (Normal)"},
    "ai_hard": {"th": "AI (ยาก)", "en": "AI (Hard)"},
    # -- เหตุที่เกมจบ
    "end_no_legal_moves": {
        "th": "จบเพราะไม่มีการเล่นที่ถูกต้องเหลือ",
        "en": "Ended: no legal moves remained",
    },
    "end_exhaustion": {
        "th": "จบเพราะไม่มีการทำคะแนนติดต่อกันจนครบลิมิต",
        "en": "Ended: too many turns without scoring",
    },
    "end_agreement": {"th": "จบเพราะผู้เล่นตกลงจบเกม", "en": "Ended: players agreed to stop"},
    "end_resign": {"th": "จบเพราะมีผู้ยอมแพ้", "en": "Ended: a player resigned"},
    "end_timeout": {"th": "จบเพราะมีผู้เล่นหายไปนานเกินไป", "en": "Ended: a player was away too long"},
    # -- โปรโตคอล
    "invalid_message": {"th": "ข้อความไม่ถูกต้อง", "en": "Malformed message"},
    "not_json": {"th": "ข้อความไม่ใช่ JSON ที่ถูกต้อง", "en": "Message is not valid JSON"},
    "no_session": {"th": "ยังไม่ได้เริ่มการเชื่อมต่อ", "en": "No session yet"},
    "unknown_command": {"th": "ไม่รู้จักคำสั่ง {action}", "en": "Unknown command {action}"},
    "server_error": {"th": "เซิร์ฟเวอร์ผิดพลาด", "en": "Server error"},
    "protocol_mismatch": {
        "th": "เวอร์ชันไม่ตรงกัน (เซิร์ฟเวอร์ {server} คุณ {client}) กรุณาอัปเดต",
        "en": "Protocol mismatch (server {server}, client {client}) please update",
    },
    # -- แมตช์
    "not_in_match": {"th": "คุณไม่ได้อยู่ในเกม", "en": "You are not in a match"},
    "first_player": {"th": "{name} ได้เดินก่อน", "en": "{name} moves first"},
    "player_resigned": {"th": "{name} ยอมแพ้", "en": "{name} resigned"},
    "turn_timeout_autopilot": {
        "th": "หมดเวลาของ {name} ให้ AI คุมแทนจนกว่าจะกลับมาเล่นเอง",
        "en": "{name} ran out of time, AI is taking over until they play again",
    },
    "player_left_autopilot": {
        "th": "{name} ออกจากเกม AI คุมที่นั่งแทน",
        "en": "{name} left, AI is playing their seat",
    },
    "autopilot_on": {"th": "AI เข้าคุมที่นั่งของ {name}", "en": "AI took over the seat of {name}"},
    "autopilot_off": {"th": "{name} กลับมาคุมเอง", "en": "{name} is back in control"},
    "player_disconnected": {"th": "{name} หลุดการเชื่อมต่อ", "en": "{name} disconnected"},
    "player_reconnected": {"th": "{name} กลับเข้ามาแล้ว", "en": "{name} reconnected"},
    "end_offer_declined": {"th": "{name} ขอเล่นต่อ", "en": "{name} wants to keep playing"},
    "end_offer_cancelled": {
        "th": "{name} ถอนคำขอจบเกมแล้ว",
        "en": "{name} withdrew the request to end",
    },
    "welcome_back": {"th": "ยินดีต้อนรับ {name}", "en": "Welcome, {name}"},
    # -- เพื่อน
    "player_not_found": {"th": "ไม่พบผู้เล่นคนนี้", "en": "No such player"},
    "friend_self": {"th": "เพิ่มตัวเองเป็นเพื่อนไม่ได้", "en": "You cannot add yourself"},
    "already_friends": {"th": "เป็นเพื่อนกันอยู่แล้ว", "en": "You are already friends"},
    "friend_request_pending": {
        "th": "ส่งคำขอไปแล้ว รอการตอบรับ",
        "en": "Request already sent, waiting for a reply",
    },
    "friend_request_gone": {"th": "คำขอนี้ไม่อยู่แล้ว", "en": "That request is no longer available"},
    # -- บัญชีผู้ใช้
    "accounts_disabled": {
        "th": "เซิร์ฟเวอร์นี้ไม่ได้เปิดระบบบัญชีผู้ใช้",
        "en": "Accounts are not enabled on this server",
    },
    "unauthorized": {"th": "ยังไม่ได้เข้าสู่ระบบ", "en": "Not signed in"},
    "user_not_found": {"th": "ไม่พบบัญชีนี้", "en": "Account not found"},
    "username_taken": {"th": "ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว", "en": "That username is taken"},
    "email_taken": {"th": "อีเมลนี้ถูกใช้ไปแล้ว", "en": "That email is already registered"},
    "invalid_credentials": {
        "th": "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
        "en": "Incorrect username or password",
    },
    "invalid_email": {"th": "รูปแบบอีเมลไม่ถูกต้อง", "en": "That email address is not valid"},
    "invalid_username": {
        "th": "ชื่อผู้ใช้ต้องเป็น a-z, 0-9 หรือ _ ยาว 3-20 ตัว",
        "en": "Username must be a-z, 0-9 or _ and 3-20 characters",
    },
    "weak_password": {
        "th": "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร",
        "en": "Password must be at least 8 characters",
    },
    "password_too_long": {"th": "รหัสผ่านยาวเกินไป", "en": "Password is too long"},
    "email_not_found": {"th": "ไม่พบบัญชีที่ใช้อีเมลนี้", "en": "No account uses that email"},
    "otp_sent": {
        "th": "ถ้าอีเมลนี้มีบัญชีอยู่ ระบบได้ส่งรหัสไปให้แล้ว",
        "en": "If that email has an account, a code has been sent",
    },
    "otp_invalid": {
        "th": "รหัสไม่ถูกต้องหรือหมดอายุแล้ว",
        "en": "That code is wrong or has expired",
    },
    "otp_too_many_attempts": {
        "th": "กรอกรหัสผิดหลายครั้งเกินไป ขอรหัสใหม่อีกครั้ง",
        "en": "Too many wrong attempts, request a new code",
    },
    "verification_sent": {
        "th": "ส่งรหัสยืนยันไปที่อีเมลแล้ว",
        "en": "A verification code has been sent to your email",
    },
    "email_already_verified": {"th": "อีเมลนี้ยืนยันแล้ว", "en": "That email is already verified"},
    "google_disabled": {
        "th": "เซิร์ฟเวอร์นี้ไม่ได้เปิดล็อกอินด้วย Google",
        "en": "Google sign-in is not enabled on this server",
    },
    "google_invalid": {
        "th": "ตรวจสอบโทเคนของ Google ไม่ผ่าน",
        "en": "Could not verify that Google token",
    },
    "password_changed": {
        "th": "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว",
        "en": "Your password has been changed",
    },
    "reset_email_subject": {
        "th": "รหัสตั้งรหัสผ่านใหม่หมากไทย: {code}",
        "en": "Your mak-thai password reset code: {code}",
    },
    "reset_email_body": {
        "th": (
            "มีคนขอตั้งรหัสผ่านใหม่ให้บัญชีนี้ รหัสคือ {code}\n\n"
            "ใช้ได้ภายใน {minutes} นาที และใช้ได้ครั้งเดียว\n"
            "ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ"
        ),
        "en": (
            "Someone asked to set a new password for this account. Your code is {code}\n\n"
            "It is valid for {minutes} minutes and can be used once.\n"
            "If this was not you, do nothing — your current password still works."
        ),
    },
    "otp_email_subject": {
        "th": "รหัสยืนยันหมากไทย: {code}",
        "en": "Your mak-thai code: {code}",
    },
    "otp_email_body": {
        "th": (
            "รหัสยืนยันของคุณคือ {code}\n\n"
            "ใช้ได้ภายใน {minutes} นาที และใช้ได้ครั้งเดียว\n"
            "ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร"
        ),
        "en": (
            "Your verification code is {code}\n\n"
            "Valid for {minutes} minutes, single use.\n"
            "If you did not request this, you can ignore this email."
        ),
    },
    "rate_limited": {
        "th": "ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่",
        "en": "Too many attempts, please wait and try again",
    },
    # -- ห้อง
    "busy": {
        "th": "ต้องออกจากห้องหรือเกมปัจจุบันก่อน",
        "en": "Leave your current room or match first",
    },
    "room_not_found": {"th": "ไม่พบห้องรหัส {code}", "en": "No room with code {code}"},
    "room_playing": {"th": "ห้องนี้กำลังเล่นอยู่", "en": "That room is already playing"},
    "room_full": {"th": "ห้องเต็มแล้ว", "en": "That room is full"},
    "room_full_for_bot": {
        "th": "ห้องเต็มแล้ว ต้องเพิ่มจำนวนผู้เล่นก่อน",
        "en": "Room is full, raise the player limit first",
    },
    "already_in_room": {"th": "คุณอยู่ในห้องนี้อยู่แล้ว", "en": "You are already in this room"},
    "not_in_room": {"th": "คุณไม่ได้อยู่ในห้อง", "en": "You are not in a room"},
    "not_room_host": {"th": "เฉพาะเจ้าของห้องเท่านั้นที่เริ่มเกมได้", "en": "Only the host can start"},
    "not_room_host_bots": {
        "th": "เฉพาะเจ้าของห้องเท่านั้นที่จัดการบอทได้",
        "en": "Only the host can manage bots",
    },
    "room_needs_players": {"th": "ยังรอผู้เล่นอีกคนอยู่", "en": "Waiting for another player"},
    "room_closed_host_left": {"th": "เจ้าของห้องออกจากห้อง", "en": "The host left the room"},
    "room_closed_you_left": {"th": "ออกจากห้องแล้ว", "en": "You left the room"},
    "player_left_room": {"th": "{name} ออกจากห้อง", "en": "{name} left the room"},
    # -- บอทและคำเชิญ
    "bad_ai_level": {"th": "ระดับบอทไม่ถูกต้อง", "en": "Unknown bot level"},
    "bot_not_found": {"th": "ไม่พบบอทตัวนี้ในห้อง", "en": "No such bot in this room"},
    "cannot_manage_bots": {"th": "จัดการบอทไม่ได้ตอนนี้", "en": "Cannot manage bots right now"},
    "invite_needs_room": {
        "th": "ต้องอยู่ในห้องก่อนถึงจะชวนคนอื่นได้",
        "en": "Create a room before inviting anyone",
    },
    "invite_room_full": {"th": "ห้องเต็มแล้ว ชวนเพิ่มไม่ได้", "en": "The room is full"},
    "invite_sent": {"th": "ชวน {name} เข้าห้องแล้ว", "en": "Invited {name} to your room"},
    "invite_target_busy": {
        "th": "{name} กำลังอยู่ในเกมหรือห้องอื่น",
        "en": "{name} is in another game or room",
    },
    "invite_target_offline": {"th": "ผู้เล่นคนนี้ไม่ออนไลน์", "en": "That player is offline"},
    # -- ข้อผิดพลาดที่ใช้ร่วมกันทุกเกม
    "game_ended": {"th": "เกมจบแล้ว", "en": "The game has ended"},
    "not_your_turn": {"th": "ยังไม่ถึงตาคุณ", "en": "It is not your turn"},
    "unknown_player": {"th": "ไม่มีผู้เล่นคนนี้", "en": "No such player"},
    "already_retired": {"th": "ผู้เล่นคนนี้ถอนตัวไปแล้ว", "en": "That player already withdrew"},
    "unknown_action": {"th": "ไม่รู้จักคำสั่ง {action}", "en": "Unknown action {action}"},
    "no_legal_action": {"th": "ไม่มีการเล่นที่ถูกต้อง", "en": "No legal action available"},
    # -- กติกาของหมากสี่กระดาน
    "must_finish_chain": {"th": "ต้องกินต่อให้จบ chain ก่อน", "en": "Finish the capture chain first"},
    "empty_square": {"th": "ช่องนี้ไม่มีหมาก", "en": "That square is empty"},
    "piece_stuck": {
        "th": "หมากตัวนี้กินไม่ได้และขยับไม่ได้",
        "en": "That piece can neither capture nor move",
    },
    "already_acted": {"th": "ลงมือไปแล้วในเทิร์นนี้", "en": "You have already acted this turn"},
    "touch_move": {
        "th": "จับหมากแล้วต้องเดินตัวนี้",
        "en": "Touch-move: you must play the piece you picked up",
    },
    "no_piece_selected": {"th": "ยังไม่ได้เลือกหมาก", "en": "No piece selected"},
    "piece_cannot_capture": {"th": "หมากตัวนี้กินไม่ได้", "en": "That piece cannot capture"},
    "no_more_captures": {"th": "ไม่มีการกินต่อจากตำแหน่งนี้", "en": "No further captures from here"},
    "must_take_maximum": {
        "th": "ต้องเลือกเส้นทางที่กินได้มากที่สุด (ลงได้ที่ {squares})",
        "en": "You must take the longest capture chain (playable: {squares})",
    },
    "illegal_jump": {
        "th": "กระโดดไปช่องนั้นไม่ได้ (ลงได้ที่ {squares})",
        "en": "Illegal jump (playable: {squares})",
    },
    "must_capture": {"th": "หมากตัวนี้กินได้ จึงต้องกิน", "en": "That piece can capture, so it must"},
    "illegal_move": {"th": "เดินไปช่องนั้นไม่ได้", "en": "That move is not legal"},
    "nothing_played": {
        "th": "ยังไม่ได้เดินอะไรเลยในเทิร์นนี้",
        "en": "You have not played anything yet",
    },
    "chain_forced": {
        "th": "โหมดนี้บังคับให้กินต่อจนสุด chain",
        "en": "This mode forces you to finish the chain",
    },
}


def resolve_locale(value: object) -> Locale:
    return value if value in LOCALES else DEFAULT_LOCALE


def render(code: str, params: dict[str, Any] | None = None, locale: Locale = DEFAULT_LOCALE) -> str:
    """เติมค่าลงในข้อความ ใช้ทั้งฝั่ง server (log) และ client ที่ดึงแคตตาล็อกไปใช้"""
    values = params or {}
    translations = MESSAGES.get(code)
    if translations is None:
        return code
    template = translations.get(locale) or translations[DEFAULT_LOCALE]

    def substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            return match.group(0)
        value = values[key]
        return (
            ", ".join(str(item) for item in value)
            if isinstance(value, list | tuple)
            else str(value)
        )

    return _PLACEHOLDER.sub(substitute, template)


def catalog_for(locale: Locale) -> dict[str, str]:
    """แคตตาล็อกของภาษาเดียว สำหรับส่งให้ client ไปใช้"""
    return {
        code: translations.get(locale, translations[DEFAULT_LOCALE])
        for code, translations in MESSAGES.items()
    }
