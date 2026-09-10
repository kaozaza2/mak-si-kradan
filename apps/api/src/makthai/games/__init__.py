"""เกมทั้งหมดของแพลตฟอร์ม

การ import แพ็กเกจนี้จะทำให้ทุกเกมลงทะเบียนตัวเองเข้า `makthai.domain.registry`
เพิ่มเกมใหม่ = สร้างแพ็กเกจใหม่ข้าง ๆ แล้วเพิ่ม import ตรงนี้บรรทัดเดียว
"""

from makthai.domain.registry import registry
from makthai.games import mak_si_kradan  # noqa: F401  (import เพื่อให้ลงทะเบียนตัวเอง)

__all__ = ["registry"]
