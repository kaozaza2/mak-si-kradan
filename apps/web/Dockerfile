# สร้างเว็บเป็นไฟล์คงที่ แล้วส่งไฟล์นั้นไปเสิร์ฟ
# แยกสองจั่นหน้าเพราะตอนพัฒนาต้องรีโหลดได้ แต่ตอนรันจริงต้องไม่มีเครื่องมือ build
#
# ต้อง build จากรากของ workspace ไม่ใช่จาก apps/web
# เพราะ pnpm-lock.yaml และ pnpm-workspace.yaml อยู่ที่ราก
# ถ้า build จาก apps/web จะหา lock ไม่เจอและ --frozen-lockfile จะล้ม
# ใน CI จึงต้องระบุ context เป็นราก และ dockerfile เป็น apps/web/Dockerfile
FROM node:22-alpine AS build

WORKDIR /workspace

# manifest กับ lock มาก่อนโค้ด ชั้นนี้จะแคชได้จนกว่าจะเปลี่ยน dependency
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN corepack enable

COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    cd apps/web && pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY apps/web/ ./apps/web/
RUN cd apps/web && pnpm build


FROM nginx:1.27-alpine AS release

# ตัว nginx จะเขียนลงได้แค่ในสองที่นี้ จึงไม่ต้องให้สิทธิ์ root
RUN chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d \
    && touch /var/run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid

COPY --chown=nginx:nginx apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /workspace/apps/web/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
