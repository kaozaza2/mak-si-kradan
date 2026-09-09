/**
 * สร้างตารางใน SQLite จาก prisma/init.sql (SQL ที่ generate จาก schema.prisma)
 *
 * มีไว้เพื่อให้ runtime image ไม่ต้องแบก prisma CLI กับ engine ทั้งชุดติดไปด้วย
 * ถ้าฐานข้อมูลมีตารางอยู่แล้วจะไม่ทำอะไร
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("ไม่ได้ตั้ง DATABASE_URL — ข้ามการเตรียมฐานข้อมูล");
  process.exit(0);
}
if (!url.startsWith("file:")) {
  console.error(`สคริปต์นี้รองรับเฉพาะ SQLite (file:) แต่ได้ ${url}`);
  process.exit(1);
}

const file = url.slice("file:".length);
mkdirSync(dirname(file), { recursive: true });

const database = new Database(file, { create: true });
const existing = database
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Match'")
  .get();

if (existing) {
  console.log("ฐานข้อมูลพร้อมใช้งานอยู่แล้ว");
} else {
  const sql = await Bun.file(new URL("../prisma/init.sql", import.meta.url)).text();
  database.exec(sql);
  console.log(`สร้างตารางในฐานข้อมูลเรียบร้อย: ${file}`);
}
database.close();
