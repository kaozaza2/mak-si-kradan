# สร้างเว็บเป็นไฟล์คงที่ แล้วส่งไฟล์นั้นไปเสิร์ฟ
# แยกสองจั่นหน้าเพราะตอนพัฒนาต้องรีโหลดได้ แต่ตอนรันจริงต้องไม่มีเครื่องมือ build
FROM node:22-alpine AS build

WORKDIR /app

# lock กับ manifest มาก่อน ชั้นนี้จะแคชได้จนกว่าจะเปลี่ยน dependency
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build


FROM nginx:1.27-alpine AS release

# ตัว nginx จะเขียนลงได้แค่ในสองที่นี้ จึงไม่ต้องให้สิทธิ์ root
RUN chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d \
    && touch /var/run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid

COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
