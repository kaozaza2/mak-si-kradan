"""รูปร่างข้อมูลที่ API ตอบกลับ

ไม่มีข้อความภาษาคนอยู่ในนี้เลย มีแต่รหัสกับตัวเลข ส่วนคำแปลอยู่ในแคตตาล็อกข้อความ
ที่ client ดึงไปใช้ เพราะเซิร์ฟเวอร์ไม่รู้ว่า client ใช้ภาษาอะไร และ client ควรตัดสินใจ
จากรหัส ไม่ใช่เทียบสตริงที่พังทันทีที่แก้คำพูด
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class GameSummary(BaseModel):
    id: str
    icon: str
    min_players: int = Field(serialization_alias="minPlayers")
    max_players: int = Field(serialization_alias="maxPlayers")
    default_turn_seconds: int = Field(serialization_alias="defaultTurnSeconds")
    modes: list[str]
    bot_levels: list[str] = Field(serialization_alias="botLevels")
    has_bots: bool = Field(serialization_alias="hasBots")
    #: คนที่กำลังอยู่ในแมตช์ของเกมนี้
    playing: int = 0
    #: ห้อง public ที่ยังเข้าได้
    open_rooms: int = Field(default=0, serialization_alias="openRooms")

    model_config = {"populate_by_name": True}


class GameListResponse(BaseModel):
    games: list[GameSummary]


class ConfigResponse(BaseModel):
    api_version: int = Field(serialization_alias="apiVersion")
    protocol_version: int = Field(serialization_alias="protocolVersion")
    environment: str
    locales: list[str]
    default_locale: str = Field(serialization_alias="defaultLocale")
    games: list[str]
    #: เปิดระบบบัญชีผู้ใช้หรือไม่ — ปิดเมื่อไม่ได้ต่อฐานข้อมูล
    accounts: bool = False

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    ok: bool
    app: str
    games: int
