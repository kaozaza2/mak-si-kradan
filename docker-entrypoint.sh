#!/bin/sh
set -e

# ตั้ง DATABASE_URL ไว้เมื่อไร ก็เตรียมตารางให้พร้อมก่อนเปิดเซิร์ฟเวอร์
# ไม่ตั้งก็ข้ามไป เกมยังเล่นได้ครบ แค่ไม่บันทึกประวัติ
if [ -n "$DATABASE_URL" ]; then
  bun scripts/init-db.ts
fi

exec "$@"
