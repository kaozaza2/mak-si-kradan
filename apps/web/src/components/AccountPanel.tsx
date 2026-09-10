import { useState } from "react";
import { t } from "../i18n/messages";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";

/** เข้าสู่ระบบ สมัคร และสถานะบัญชี */
export function AccountPanel() {
  const { accountsEnabled, account } = useAppState();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!accountsEnabled) return null;

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
            <div className="warn">{ui("unverifiedNote")}</div>
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
      </form>
    </details>
  );
}
