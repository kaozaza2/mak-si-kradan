/**
 * ส่งอีเมล
 *
 * แยกเป็น interface เพราะผู้ให้บริการอีเมลเปลี่ยนกันบ่อย และเทสต์ต้องไม่ยิงจริง
 * ค่าเริ่มต้นคือพิมพ์ลง console ให้เห็นรหัส OTP ตอน dev โดยไม่ต้องตั้งอะไรเลย
 */

import { DEFAULT_LOCALE, type Locale, renderMessage } from "./messages.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly name: string;
  send(email: OutgoingEmail): Promise<void>;
}

/** โหมด dev — ไม่ส่งจริง แค่พิมพ์ให้เห็น */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
    console.log(`\n─── mail to ${email.to} ───\n${email.subject}\n${email.text}\n───\n`);
  }
}

/**
 * ส่งผ่าน HTTP endpoint ที่ผู้ใช้กำหนดเอง
 * ทำให้ต่อกับผู้ให้บริการไหนก็ได้โดยไม่ต้องผูกโค้ดกับเจ้าใดเจ้าหนึ่ง
 */
export class WebhookMailer implements Mailer {
  readonly name = "webhook";

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(email: OutgoingEmail): Promise<void> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(email),
    });
    if (!response.ok) throw new Error(`mail delivery failed (${response.status})`);
  }
}

export function mailerFromEnv(env = process.env): Mailer {
  return env.MAIL_WEBHOOK_URL
    ? new WebhookMailer(env.MAIL_WEBHOOK_URL, env.MAIL_WEBHOOK_TOKEN)
    : new ConsoleMailer();
}

/**
 * อีเมลเป็นข้อความที่คนอ่านจริง ๆ จึงต้องแปล — ต่างจาก packet ที่ส่งแค่ code
 * แต่ก็ดึงจากแคตตาล็อกเดียวกัน ภาษาจะได้ไม่กระจัดกระจายอยู่หลายที่
 */
export function otpEmail(code: string, minutes: number, locale: Locale = DEFAULT_LOCALE): Omit<OutgoingEmail, "to"> {
  return {
    subject: renderMessage("otp_email_subject", { code }, locale),
    text: renderMessage("otp_email_body", { code, minutes }, locale),
  };
}
