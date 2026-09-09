# หมากสี่กระดาน — ไม่มี build step ทั้ง server และ client จึงรันซอร์สตรง ๆ ด้วย Bun

FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
# ติดตั้งครบทุก dependency เพื่อใช้ prisma CLI generate client และแปลงสคีมาเป็น SQL
RUN bun install --frozen-lockfile \
 && bunx prisma generate \
 && bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/init.sql

FROM oven/bun:1.4-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
# --omit=peer สำคัญ: @prisma/client ประกาศ prisma CLI (50MB) กับ typescript
# เป็น optional peer ถ้าไม่ตัดออก image จะพองขึ้นหลายร้อย MB โดยไม่ได้ใช้
RUN bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    TURN_SECONDS=45

# runtime ไม่ต้องมี prisma CLI กับ engine ทั้งชุด (ใหญ่เป็นร้อย MB)
# เอาแค่ Prisma Client ที่ generate แล้ว กับ SQL สำหรับสร้างตาราง
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/prisma/init.sql ./prisma/init.sql
COPY package.json bun.lock ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY src ./src
COPY public ./public
COPY scripts/init-db.ts ./scripts/init-db.ts
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# โฟลเดอร์สำหรับไฟล์ SQLite — ต้องเป็นของ user bun ไม่งั้น named volume
# จะถูกสร้างเป็นของ root แล้วเขียนไม่ได้
RUN mkdir -p /app/data && chown -R bun:bun /app/data && chmod +x ./docker-entrypoint.sh

USER bun
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r = await fetch(\`http://127.0.0.1:\${process.env.PORT ?? 3000}/health\`); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "src/server/index.ts"]
