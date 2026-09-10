/**
 * ปุ่มล็อกอินด้วย Google
 *
 * โหลดสคริปต์ของ Google ตอนที่จะใช้จริงเท่านั้น ไม่ใส่ไว้ใน index.html
 * เพราะคนส่วนใหญ่เข้ามาเล่นเลยโดยไม่ล็อกอิน ไม่ควรต้องโหลดของนี้ทุกครั้ง
 * และเซิร์ฟเวอร์ที่ไม่ได้เปิดใช้ Google ก็ไม่ต้องยิงออกนอกเลยสักครั้ง
 *
 * สิ่งที่ได้จากตรงนี้คือ ID token ซึ่งเซิร์ฟเวอร์ตรวจลายเซ็นเองอีกที
 * ฝั่งหน้าเว็บไม่เชื่อถืออะไรจากตรงนี้ทั้งนั้น
 */

const SCRIPT_URL = "https://accounts.google.com/gsi/client";

interface CredentialResponse {
  credential?: string;
}

interface GoogleAccounts {
  id: {
    initialize(options: {
      client_id: string;
      callback: (response: CredentialResponse) => void;
    }): void;
    renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  };
}

declare global {
  interface Window {
    google?: { accounts?: GoogleAccounts };
  }
}

let loading: Promise<GoogleAccounts | null> | null = null;

function loadScript(): Promise<GoogleAccounts | null> {
  if (loading) return loading;
  loading = new Promise<GoogleAccounts | null>((resolve) => {
    if (window.google?.accounts) return resolve(window.google.accounts);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.google?.accounts ?? null);
    // โหลดไม่ได้ก็ไม่เป็นไร ปุ่มจะไม่ขึ้น แต่ล็อกอินด้วยรหัสผ่านยังใช้ได้
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return loading;
}

/** วาดปุ่มลงใน element ที่ให้มา คืนค่า false เมื่อวาดไม่ได้ */
export async function renderGoogleButton(
  parent: HTMLElement,
  clientId: string,
  onToken: (idToken: string) => void,
): Promise<boolean> {
  const accounts = await loadScript();
  if (!accounts) return false;
  try {
    accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        if (response.credential) onToken(response.credential);
      },
    });
    accounts.id.renderButton(parent, {
      type: "standard",
      theme: "filled_black",
      size: "large",
      shape: "pill",
      width: 260,
    });
  } catch {
    return false;
  }
  return true;
}

/** ให้เทสต์เริ่มใหม่ได้ เพราะสคริปต์ถูกแคชไว้ระดับโมดูล */
export function resetGoogleLoader(): void {
  loading = null;
}
