"""ส่งอีเมล

แยกเป็นสัญญาเพราะผู้ให้บริการอีเมลเปลี่ยนกันบ่อย และเทสต์ต้องไม่ยิงจริง
ค่าเริ่มต้นคือพิมพ์ลงบันทึกให้เห็นรหัสตอนพัฒนา โดยไม่ต้องตั้งอะไรเลย

อีเมลเป็นข้อความที่คนอ่านจริง จึงต้องแปล ต่างจาก packet ที่ส่งแค่รหัส
แต่ก็ดึงจากแคตตาล็อกเดียวกัน ภาษาจะได้ไม่กระจัดกระจายอยู่หลายที่
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Protocol

import aiosmtplib
import httpx

from makthai.messages import DEFAULT_LOCALE, Locale, render

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Email:
    to: str
    subject: str
    body: str


class Mailer(Protocol):
    name: str

    async def send(self, email: Email) -> None: ...


class ConsoleMailer:
    """โหมดพัฒนา — ไม่ส่งจริง แค่บันทึกให้เห็น"""

    name = "console"

    def __init__(self) -> None:
        self.sent: list[Email] = []

    async def send(self, email: Email) -> None:
        self.sent.append(email)
        logger.info("mail to %s | %s | %s", email.to, email.subject, email.body)


class WebhookMailer:
    """ส่งผ่าน endpoint ที่ผู้ใช้กำหนดเอง

    ทำให้ต่อกับผู้ให้บริการไหนก็ได้โดยไม่ผูกโค้ดกับเจ้าใดเจ้าหนึ่ง
    """

    name = "webhook"

    def __init__(self, url: str, token: str = "") -> None:
        self.url = url
        self.token = token

    async def send(self, email: Email) -> None:
        headers = {"authorization": f"Bearer {self.token}"} if self.token else {}
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                self.url,
                json={"to": email.to, "subject": email.subject, "text": email.body},
                headers=headers,
            )
            response.raise_for_status()


#: อีเมลที่ส่งได้ แยกตามเหตุที่ส่ง — ตารางเดียวแทนที่จะเป็นฟังก์ชันต่อหนึ่งแบบ
OTP_TEMPLATES = {
    "verify_email": ("otp_email_subject", "otp_email_body"),
    "reset_password": ("reset_email_subject", "reset_email_body"),
}


class SmtpMailer:
    """ส่งผ่าน SMTP

    มีไว้ทั้งสำหรับผู้ให้บริการจริง และสำหรับกล่องจดหมายทดสอบใน Docker
    ซึ่งทำให้ทดสอบระบบบัญชีทั้งวงได้โดยไม่ส่งอีเมลออกไปหาใครจริง ๆ
    """

    name = "smtp"

    def __init__(
        self,
        *,
        host: str,
        port: int,
        sender: str,
        username: str = "",
        password: str = "",
        start_tls: bool = False,
    ) -> None:
        self.host = host
        self.port = port
        self.sender = sender
        self.username = username
        self.password = password
        self.start_tls = start_tls

    async def send(self, email: Email) -> None:
        message = EmailMessage()
        message["From"] = self.sender
        message["To"] = email.to
        message["Subject"] = email.subject
        message.set_content(email.body)
        await aiosmtplib.send(
            message,
            hostname=self.host,
            port=self.port,
            start_tls=self.start_tls or None,
            username=self.username or None,
            password=self.password or None,
            timeout=10,
        )


def otp_email(
    to: str,
    code: str,
    minutes: int,
    locale: Locale = DEFAULT_LOCALE,
    purpose: str = "verify_email",
) -> Email:
    subject, body = OTP_TEMPLATES[purpose]
    params = {"code": code, "minutes": minutes}
    return Email(to=to, subject=render(subject, params, locale), body=render(body, params, locale))


def create_mailer(settings: Any) -> Mailer:
    """เลือกวิธีส่งจากสิ่งที่ตั้งไว้ — ไม่ตั้งอะไรเลยก็ยังใช้งานได้ทันที"""
    if settings.smtp_host:
        return SmtpMailer(
            host=settings.smtp_host,
            port=settings.smtp_port,
            sender=settings.mail_from,
            username=settings.smtp_username,
            password=settings.smtp_password,
            start_tls=settings.smtp_start_tls,
        )
    if settings.mail_webhook_url:
        return WebhookMailer(settings.mail_webhook_url, settings.mail_webhook_token)
    return ConsoleMailer()
