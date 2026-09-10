import { useEffect, useRef, useState } from "react";
import { renderGoogleButton } from "../api/google";
import { t } from "../i18n/messages";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";

/** ปุ่มของ Google — วาดโดยสคริปต์ของ Google เอง เพื่อให้ผ่านข้อกำหนดแบรนด์ */
function GoogleButton() {
  const { googleClientId } = useAppState();
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!googleClientId || !slot.current) return;
    let cancelled = false;
    void renderGoogleButton(slot.current, googleClientId, (idToken) => {
      if (cancelled) return;
      void store.signInWithGoogle(idToken).then((code) => {
        if (code) store.toast(t(code), "error");
      });
    });
    return () => {
      cancelled = true;
    };
  }, [googleClientId]);

  if (!googleClientId) return null;
  return (
    <div className="google-slot">
      <div className="divider">{ui("orDivider")}</div>
      <div ref={slot} />
    </div>
  );
}

/** กรอกรหัสหกหลักที่ส่งไปทางอีเมล */
function VerifyForm({ email }: { email: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    const failure = await action();
    setBusy(false);
    if (failure) setError(t(failure));
  };

  return (
    <section className="panel verify">
      <b>{ui("verifyTitle")}</b>
      <p className="meta">{ui("verifySent", { email })}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => store.verifyOtp(email, code));
        }}
      >
        <input
          aria-label={ui("verifyCode")}
          placeholder={ui("verifyCode")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
        />
        <div className="row">
          <button className="primary small" type="submit" disabled={busy || code.length < 6}>
            {ui("verifySubmit")}
          </button>
          <button
            className="ghost small"
            type="button"
            disabled={busy}
            onClick={() => void run(() => store.resendOtp(email))}
          >
            {ui("resendCode")}
          </button>
          <button className="ghost small" type="button" onClick={() => store.dismissVerification()}>
            {ui("verifyLater")}
          </button>
        </div>
        {error ? <p className="warn">{error}</p> : null}
      </form>
    </section>
  );
}

/** ลืมรหัสผ่าน — ขอรหัสทางอีเมล แล้วตั้งรหัสใหม่ด้วยรหัสนั้น */
function ResetForm({ step, email }: { step: "ask" | "code"; email: string }) {
  const [address, setAddress] = useState(email);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    const failure = await action();
    setBusy(false);
    if (failure) setError(t(failure));
  };

  return (
    <section className="panel verify">
      <b>{ui("resetTitle")}</b>
      <p className="meta">{step === "ask" ? ui("resetAsk") : ui("verifySent", { email })}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            step === "ask"
              ? store.forgotPassword(address)
              : store.resetPassword(email, code, password),
          );
        }}
      >
        {step === "ask" ? (
          <input
            type="email"
            aria-label={ui("emailOrUsername")}
            placeholder={ui("emailOrUsername")}
            autoComplete="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        ) : (
          <>
            <input
              aria-label={ui("verifyCode")}
              placeholder={ui("verifyCode")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
            <input
              type="password"
              aria-label={ui("newPassword")}
              placeholder={ui("newPassword")}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </>
        )}
        <div className="row">
          <button
            className="primary small"
            type="submit"
            disabled={busy || (step === "code" && code.length < 6)}
          >
            {step === "ask" ? ui("sendResetCode") : ui("resetSubmit")}
          </button>
          <button
            className="ghost small"
            type="button"
            onClick={() => store.cancelPasswordReset()}
          >
            {ui("cancel")}
          </button>
        </div>
        {error ? <p className="warn">{error}</p> : null}
      </form>
    </section>
  );
}

/** เข้าสู่ระบบ สมัคร และสถานะบัญชี */
export function AccountPanel() {
  const { accountsEnabled, account, pendingVerification, passwordReset } = useAppState();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!accountsEnabled) return null;
  if (pendingVerification) return <VerifyForm email={pendingVerification} />;
  if (passwordReset) return <ResetForm step={passwordReset.step} email={passwordReset.email} />;

  if (account) {
    return (
      <section className="panel account">
        <div>
          <b>{account.name}</b>
          <span className="rating">{account.rating}</span>
          <div className="meta">
            {ui("record", {
              wins: account.wins,
              losses: account.losses,
              draws: account.draws,
              games: account.gamesPlayed,
            })}
          </div>
          {account.email && !account.verified ? (
            <div className="warn">
              {ui("unverifiedNote")}{" "}
              <button
                className="link"
                type="button"
                onClick={() => store.startVerification(account.email as string)}
              >
                {ui("verifyNow")}
              </button>
            </div>
          ) : null}
        </div>
        <button className="ghost small" onClick={() => store.signOut()}>
          {ui("signOut")}
        </button>
      </section>
    );
  }

  const submit = async (path: string) => {
    setBusy(true);
    setError("");
    const isEmail = identifier.includes("@");
    const code = await store.authenticate(path, {
      ...(isEmail ? { email: identifier } : { username: identifier }),
      password,
      displayName: isEmail ? identifier.split("@")[0] : identifier,
    });
    setBusy(false);
    if (code) setError(t(code));
    else {
      setIdentifier("");
      setPassword("");
    }
  };

  return (
    <details className="panel account-form">
      <summary>{ui("signInPrompt")}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit("/api/v1/auth/login");
        }}
      >
        <input
          aria-label={ui("emailOrUsername")}
          placeholder={ui("emailOrUsername")}
          autoComplete="username"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />
        <input
          type="password"
          aria-label={ui("password")}
          placeholder={ui("password")}
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="row">
          <button className="primary small" type="submit" disabled={busy}>
            {ui("signIn")}
          </button>
          <button
            className="ghost small"
            type="button"
            disabled={busy}
            onClick={() => void submit("/api/v1/auth/register")}
          >
            {ui("signUp")}
          </button>
        </div>
        {error ? <p className="warn">{error}</p> : null}
        <button
          className="link"
          type="button"
          onClick={() => store.startPasswordReset(identifier.includes("@") ? identifier : "")}
        >
          {ui("forgotPassword")}
        </button>
      </form>
      <GoogleButton />
    </details>
  );
}
