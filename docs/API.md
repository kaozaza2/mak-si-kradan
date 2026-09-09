# API สำหรับ client ทุกแพลตฟอร์ม

เอกสารนี้มีไว้ให้เขียน client ใหม่ (มือถือ, เดสก์ท็อป) ต่อกับเซิร์ฟเวอร์เดียวกับเว็บได้
เว็บ client ที่อยู่ใน `public/` ก็ใช้ทางเดียวกันนี้ทั้งหมด ไม่มีทางลัดพิเศษ

## ข้อความและภาษา

**เซิร์ฟเวอร์ไม่ส่งข้อความที่คนอ่านได้เลย** ทุกอย่างเป็น `code` กับ `params`

```jsonc
{ "type": "error", "code": "must_take_maximum", "params": { "squares": ["c4", "e6"] } }
{ "type": "info",  "code": "player_resigned",   "params": { "name": "เก้า" } }
```

เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร และเพราะ client ควรตัดสินใจจาก `code`
ไม่ใช่เทียบสตริงที่พังทันทีที่เราแก้คำพูด

REST ก็ตอบแบบเดียวกัน — ผิดพลาดคืน `{ "code": "invalid_credentials" }` ไม่ใช่ข้อความ

ข้อความมาจากที่นี่แทน:

```
GET /api/v1/messages?locale=th   → { locale, available: ["th","en"], messages: { code: "ข้อความ {name}" } }
```

ดึงมาแคชไว้ตอนเปิดแอป แล้ว render เอง — `{name}` คือที่เติมค่าจาก `params`
ค่าที่เป็น array ให้ join ด้วย `", "` และ **ถ้าเจอ code ที่ไม่รู้จักให้แสดง code ตรง ๆ
แทนที่จะเงียบ** เพราะเซิร์ฟเวอร์อาจใหม่กว่าแอป

จะไม่ใช้ endpoint นี้แล้วฝังคำแปลไว้ในแอปเองก็ได้ `code` คือสัญญา ไม่ใช่ตัวข้อความ

## หลักการที่ควรรู้ก่อน

เซิร์ฟเวอร์เป็น **authoritative** ทั้งหมด client ส่งได้แค่ *เจตนา* เช่น "เลือกหมากช่องนี้"
หรือ "วางลงช่องนี้" แล้วรอ canonical state กลับมา **อย่าคำนวณกติกาเองแล้ววาดล่วงหน้า**
เพราะกติกาต่างกันตามโหมดของห้อง และเซิร์ฟเวอร์จงใจไม่ส่งข้อมูลบางอย่างในโหมดที่ไม่ช่วยชี้เป้า

ทุก state ที่ได้รับมี `stateHash` ถ้าคำนวณเองแล้วไม่ตรง แปลว่า client เพี้ยน ให้เชื่อเซิร์ฟเวอร์

## เวอร์ชัน

```
GET /api/v1/config
→ { apiVersion, protocolVersion, accounts, google, googleClientId, emailVerification, maxPlayers, modes }
```

เรียกอันนี้ก่อนเสมอ แล้วเทียบ `protocolVersion` กับที่ client รองรับ REST เรียกได้ทั้ง
`/api/...` และ `/api/v1/...` ส่วน WebSocket ให้ส่ง `protocol` มาใน `hello`
ถ้าไม่ตรงเซิร์ฟเวอร์จะตอบ `error` แล้วไม่เปิด session ให้

CORS เปิดให้ทุก origin โดยค่าเริ่มต้น (ปรับด้วย `CORS_ORIGINS`) การยืนยันตัวตนใช้
bearer token ไม่ใช่ cookie จึงไม่มีปัญหา CSRF

## ตัวตนและ token

มี token แบบเดียวใช้ทั้ง guest และบัญชีที่สมัคร เป็น HMAC ที่เซ็นโดยเซิร์ฟเวอร์
พก `sub` (player id), `name`, `kind` และวันหมดอายุไว้ในตัว **เก็บไว้แล้วส่งกลับมาทุกครั้ง**
ที่เชื่อมต่อ ไม่งั้นจะกลายเป็นคนใหม่ทุกครั้งและ reconnect กลับเข้าเกมเดิมไม่ได้

```
POST /api/v1/auth/register  { email, password, displayName }      → { token, user, verificationRequired }
POST /api/v1/auth/verify-otp { email, code }                      → { token, user }
POST /api/v1/auth/resend-otp { email }                            → { ok }
POST /api/v1/auth/login     { email | username, password }        → { token, user }
POST /api/v1/auth/google    { idToken }                           → { token, user }
GET  /api/v1/me             Authorization: Bearer <token>         → { user }
GET  /api/v1/leaderboard?limit=50                                 → { leaderboard }
GET  /api/v1/players/:id/matches?limit=20                         → { matches }
```

**Google:** ให้ client ขอ ID token จาก SDK ของแพลตฟอร์มตัวเอง (GIS บนเว็บ,
Google Sign-In บน iOS/Android) แล้วส่ง `idToken` มาที่ `/auth/google` เซิร์ฟเวอร์ตรวจ
ลายเซ็นกับกุญแจสาธารณะของ Google เอง ไม่มี redirect flow ให้ยุ่งยากบนมือถือ
ทุก client id ที่ใช้ (เว็บ, iOS, Android) ต้องอยู่ใน `GOOGLE_CLIENT_IDS` ของเซิร์ฟเวอร์

**อีเมลยังไม่ยืนยันก็เล่นได้ทุกอย่าง** แค่แมตช์นั้นจะไม่ถูกนับ rating

## WebSocket

ต่อที่ `/ws` แล้วส่ง `hello` เป็นข้อความแรกเสมอ

```jsonc
{ "type": "hello", "token": "<token เดิมถ้ามี>", "name": "ชื่อที่อยากใช้", "protocol": 1 }
```

ได้กลับมา `session` (พร้อม token ใหม่ให้เก็บ) ตามด้วย `lobby` และถ้ามีเกมค้างอยู่
จะได้ `match_start` + `state` กลับมาเองโดยไม่ต้องขอ

### client → server

| ข้อความ | ใช้ทำอะไร |
| --- | --- |
| `quick_match` / `cancel_quick_match` | จับคู่อัตโนมัติ |
| `create_room { turnSeconds, capacity, visibility, mode }` | สร้างห้อง |
| `list_rooms` / `join_room { code }` / `leave_room` / `start_room` | จัดการห้อง |
| `add_bot { level }` / `remove_bot { playerId }` | เติม/เอา AI ออกจากห้อง (เฉพาะเจ้าของห้อง) |
| `play_ai { level, turnSeconds, mode }` | เล่นกับบอททันที |
| `list_players` / `challenge { targetId }` / `challenge_respond { challengeId, accept }` | ท้าดวล |
| `list_friends` | ขอรายชื่อเพื่อนพร้อมสถานะออนไลน์ |
| `friend_request { identifier }` | ขอเป็นเพื่อนด้วยชื่อผู้ใช้ อีเมล หรือ player id |
| `friend_respond { requestId, accept }` / `friend_remove { playerId }` | ตอบคำขอ / ลบเพื่อน |
| `invite_to_room { targetId }` | ชวนคนหนึ่งเข้าห้องที่เราอยู่ |
| `select { square }` | หยิบหมาก |
| `play { to }` | วางลงช่องนั้น ให้เซิร์ฟเวอร์ตีความเองว่ากินหรือเดิน |
| `capture { to }` / `move { to }` | ระบุชนิดเอง (ใช้ได้เมื่อโหมดชี้เป้าให้) |
| `end_turn` | จบเทิร์นทั้งที่ยังกินต่อได้ (เฉพาะโหมดที่ไม่บังคับ) |
| `cancel_select` | เปลี่ยนใจ (ไม่ได้ในโหมดจับแล้วต้องเดิน) |
| `offer_end` / `respond_end { accept }` / `resign` / `rematch` / `leave_match` | จบเกม |

**ใช้ `play` เป็นหลัก** แล้ว client จะทำงานได้เหมือนกันทุกโหมดโดยไม่ต้องรู้กติกา

### server → client

`session` `lobby` `rooms` `room` `room_closed` `queue` `players` `challenge_in`
`challenge_update` `match_start` `state` `match_end` `player_status` `autopilot`
`end_offer` `rematch_status` `info` `error` `redirect`

`info` `error` `room_closed` `redirect` พก `code` (+ `params`) ไม่ใช่ข้อความ ดูหัวข้อ
ข้อความและภาษาด้านบน

`state` คือของจริงที่ต้องใช้วาดกระดาน ฟิลด์สำคัญ:

```jsonc
{
  "board": [17, -1, 42, ...],   // 64 ช่อง, -1 = ว่าง, ที่เหลือคือ piece id
  "playerCount": 2, "scores": [12, 9], "current": 0, "retired": [],
  "selection": { "at": 27, "path": [10, 27], "capturesSoFar": 1, "availableCaptures": 3 },
  "selectable": [9, 10, 11],    // ว่างเปล่าเมื่อโหมดไม่ช่วยชี้เป้า
  "targets": [27], "targetKind": "capture",
  "canEndTurn": false,
  "rules": { "forceCapture": true, "forceMaximum": true, "assist": "full", "touchMove": false },
  "deadline": 1712345678901, "now": 1712345600000,
  "stateHash": "1a2b3c4d"
}
```

`deadline` เป็นเวลาของเซิร์ฟเวอร์ ใช้คู่กับ `now` เพื่อชดเชยนาฬิกาที่ไม่ตรงกัน
อย่าใช้นาฬิกาเครื่องตัวเองตรง ๆ

## เพื่อนและคำเชิญ

ระบบเพื่อนต้องล็อกอินก่อน (guest ไม่มีตัวตนถาวรพอ) ส่ง `list_friends` แล้วจะได้

```jsonc
{
  "type": "friends",
  "friends": [{ "id": "user_…", "name": "เก้า", "rating": 1240, "online": true, "available": true }],
  "incoming": [{ "requestId": "…", "player": { … } }],
  "outgoing": [ … ]
}
```

เซิร์ฟเวอร์ push `friends` ให้เองเมื่อมีคำขอเข้ามาหรือมีคนตอบรับ ไม่ต้อง poll
`online` ถูกต้องข้าม node ส่วน `available` บอกได้เฉพาะคนที่อยู่ node เดียวกัน

**คำเชิญเข้าห้องไม่มี state ฝั่งเซิร์ฟเวอร์เลย** — `invite_to_room` แค่ส่ง `room_invite`
ที่มีรหัสห้องไปให้ปลายทาง การตอบรับคือการส่ง `join_room { code }` ธรรมดา ซึ่งเดิน
เส้นทาง redirect ข้าม node ที่มีอยู่แล้ว ปฏิเสธก็แค่ไม่ทำอะไร ไม่ต้องแจ้งใคร

ด้วยเหตุผลเดียวกัน การท้าดวลข้าม node จะถูกแปลงเป็นห้อง + คำเชิญให้อัตโนมัติ
client จะได้รับ `room_invite` แทน `challenge_in` โดยไม่ต้องทำอะไรเพิ่ม

```
GET /api/v1/friends              Authorization: Bearer <token>
GET /api/v1/players/search?q=…   Authorization: Bearer <token>
```

## หลาย node

`match_start` มี `nodeUrl` บอกว่าแมตช์อยู่เครื่องไหน **เก็บไว้แล้วต่อกลับที่นั่น**
เมื่อหลุด ถ้าได้ข้อความ `redirect { url }` ให้ปิด socket แล้วต่อใหม่ที่ URL นั้น
พร้อม token เดิม เกิดขึ้นเมื่อจับคู่ได้กับคนที่อยู่คนละเครื่อง หรือเข้าห้องที่อยู่คนละเครื่อง

## สิ่งที่ client ไม่ควรทำ

* อย่าคิดกติกาเองแล้วปิดปุ่มล่วงหน้า — ใช้ `selectable` / `targets` / `canEndTurn` ที่ส่งมา
* อย่าใช้ `availableCaptures` เป็นตัวตัดสินใจ เพราะเป็น `null` ในโหมดที่ไม่ช่วยชี้เป้า
* อย่าเก็บ token ไว้ในที่ที่แอปอื่นอ่านได้ มันคือตัวตนของผู้เล่นทั้งหมด
* อย่าเทียบข้อความเพื่อเช็ค error — ใช้ `code` เพราะข้อความเปลี่ยนได้ทุกเมื่อ
