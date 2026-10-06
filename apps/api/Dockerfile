# ไล่ชั้นเพื่อให้เปลี่ยนโค้ดแล้วไม่ต้องติดตั้ง dependency ใหม่ทุกครั้ง
# ชั้นแรกเปลี่ยนบ่อย (โค้ดและ lock) ชั้นหลังเปลี่ยนน้อย (ไล่บรรพดูแยก)
FROM python:3.13-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# เครื่องมือเขียนแบบ standalone ติดตั้งครั้งเดียว แยกจาก dependency ของแอป
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# ก่อนโค้ด เพื่อให้ชั้นนี้แคชได้จริงเมื่อแก้เฉพาะซอร์ส
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --extra dev --no-install-project


FROM builder AS dev

# โค้ดเข้ามาทีหลัง ทำให้แก้เฉพาะซอร์สแล้วไม่ต้องติดตั้งใหม่
COPY . .
RUN uv sync --frozen --extra dev

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["uvicorn", "makthai.main:app", "--reload", "--host", "0.0.0.0", "--port", "8000"]


FROM python:3.13-slim AS release

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# ผู้ใช้เฉพาะทาง ไม่ใช่ root — ถ้าโหนดหลุดก็ยังไม่กระทบเครื่อง
RUN useradd --create-home --uid 10001 appuser

WORKDIR /app

# เฉพาะ dependency ของรันจริง ไม่เอา pytest หรือ mypy ไปด้วย
# เครื่องที่รันจริงไม่ควรมีเครื่องมือพัฒนาติดไปด้วย
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project && \
    uv cache clean --force

COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser migrations ./migrations
COPY --chown=appuser:appuser alembic.ini ./

# สร้างตารางเองไม่ได้ เพราะใน production ต้องใช้ migration
# ถ้าเปิด AUTO_CREATE_TABLES แอปจะไม่ยอมเริ่ม ตามที่ตั้งใจไว้
ENV AUTO_CREATE_TABLES=false \
    ENVIRONMENT=production

USER appuser
EXPOSE 8000

# ต้องตรวจว่ารับงานได้จริง ไม่ใช่แค่กระบวนการยังไม่ตาย
# /health ตอบว่ารอดเสมอ /ready จึงเป็นตัวที่บอกความจริง
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).status==200 else 1)"

CMD ["uvicorn", "makthai.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
