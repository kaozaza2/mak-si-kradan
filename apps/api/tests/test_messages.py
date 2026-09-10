"""แคตตาล็อกข้อความต้องครบและใช้ตัวแปรตรงกันทุกภาษา"""

import re

from makthai.domain.errors import CommonError
from makthai.games.mak_si_kradan import MakError
from makthai.messages import DEFAULT_LOCALE, LOCALES, MESSAGES, catalog_for, render

PLACEHOLDER = re.compile(r"\{(\w+)\}")


def test_ทุกรหัสมีครบทุกภาษาและไม่ว่าง():
    for code, translations in MESSAGES.items():
        for locale in LOCALES:
            assert translations.get(locale), f"{code}/{locale} ว่าง"


def test_ตัวแปรในข้อความตรงกันทุกภาษา():
    for code, translations in MESSAGES.items():
        reference = sorted(PLACEHOLDER.findall(translations[DEFAULT_LOCALE]))
        for locale in LOCALES:
            assert sorted(PLACEHOLDER.findall(translations[locale])) == reference, code


def test_ทุกรหัสข้อผิดพลาดของโดเมนมีข้อความรองรับ():
    missing = [code for code in list(CommonError) + list(MakError) if code.value not in MESSAGES]
    assert missing == []


def test_เติมค่าลงในข้อความได้รวมถึงรายการหลายค่า():
    assert render("not_your_turn", locale="en") == "It is not your turn"
    assert "c4, e6" in render("illegal_jump", {"squares": ["c4", "e6"]}, "en")
    assert render("unknown_action", {"action": "poke"}, "en") == "Unknown action poke"


def test_รหัสที่ไม่รู้จักคืนรหัสเดิมไม่ระเบิด():
    assert render("ไม่มีอยู่จริง") == "ไม่มีอยู่จริง"
    assert render("illegal_jump", {}, "en") == "Illegal jump (playable: {squares})"


def test_แคตตาล็อกต่อภาษามีครบทุกรหัส():
    for locale in LOCALES:
        assert set(catalog_for(locale)) == set(MESSAGES)
