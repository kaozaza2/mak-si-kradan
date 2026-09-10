"""ทุกรหัสที่เซิร์ฟเวอร์ส่งออกไปต้องมีคำแปล

เทสต์นี้อ่านซอร์สจริงแทนที่จะไล่รายการด้วยมือ เพราะรหัสใหม่ถูกเพิ่มบ่อยมาก
และการลืมใส่คำแปลจะไม่พังตอนรัน แต่ผู้เล่นจะเห็นรหัสดิบ ๆ บนหน้าจอแทน
"""

import re
from pathlib import Path

from makthai.messages import MESSAGES

SOURCE_ROOT = Path(__file__).resolve().parent.parent / "src" / "makthai"
WEB_ROOT = Path(__file__).resolve().parents[3] / "apps" / "web" / "src"

CODE_PATTERNS = (
    re.compile(r'"code":\s*"([a-z_]+)"'),
    re.compile(r'ActionResult\.fail\(\s*"([a-z_]+)"'),
)
#: รหัสที่ถูกประกอบตอนรันไทม์ เช่น t(`ai_${level}`) หรือ t(`game_${gameId}`)
DYNAMIC_PREFIXES = ("ai_", "game_", "tagline_", "end_")


def server_source() -> str:
    return "\n".join(
        path.read_text() for path in SOURCE_ROOT.rglob("*.py") if path.name != "messages.py"
    )


def web_source() -> str:
    if not WEB_ROOT.exists():
        return ""
    return "\n".join(path.read_text() for path in WEB_ROOT.rglob("*.ts*"))


def test_ทุกรหัสที่ส่งออกไปมีคำแปล():
    source = server_source()
    emitted = {match for pattern in CODE_PATTERNS for match in pattern.findall(source)}
    missing = sorted(code for code in emitted if code not in MESSAGES)
    assert missing == [], f"ยังไม่มีคำแปลของ {missing}"


def test_ไม่มีคำแปลที่ไม่มีใครใช้ค้างอยู่():
    """หน้าเว็บก็เป็นผู้ใช้แคตตาล็อกนี้ บางรหัสจึงถูกใช้ที่ฝั่งนั้นเท่านั้น"""
    source = server_source() + web_source()
    unused = sorted(
        code
        for code in MESSAGES
        if f'"{code}"' not in source
        and f"`{code}`" not in source
        and not code.startswith(DYNAMIC_PREFIXES)
    )
    assert unused == [], f"ไม่มีใครใช้ {unused}"


def test_รหัสที่ประกอบตอนรันไทม์ยังถูกใช้จริง():
    """กันรายการยกเว้นเน่าโดยไม่มีใครรู้"""
    source = server_source() + web_source()
    for prefix in DYNAMIC_PREFIXES:
        assert f"`{prefix}$" in source, f"ไม่พบการประกอบรหัส {prefix}"
        assert any(code.startswith(prefix) for code in MESSAGES)
