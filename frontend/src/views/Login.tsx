import { useState } from "react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "@/components/ui/Toast";
import { t } from "@/i18n/en";
import { decodeToken } from "@/lib/session";

export function LoginView() {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryIn, setRetryIn] = useState(0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (retryIn > 0) return;
    setErr(""); setBusy(true);
    const r = await apiPost<{ token: string; user: string; perms: string[]; exp: number }>("/api/login", { username: user, password: pw });
    setBusy(false);
    if (r.ok) {
      const p = decodeToken(r.data.token);
      session.setSession(r.data.token, r.data.user, p?.perms || r.data.perms);
      return;
    }
    if (r.status === 429) {
      const secs = (r.data as any).retry_after || 60;
      setRetryIn(secs);
      const tick = () => setRetryIn((v) => (v > 1 ? (setTimeout(tick, 1000), v - 1) : 0));
      setTimeout(tick, 1000);
      setErr(t("login.throttled", { seconds: secs }));
      return;
    }
    if (r.status === 401) { setErr(t("login.invalid")); return; }
    if (r.status === 500) { setErr(t("login.notConfigured")); return; }
    setErr(t("login.generic"));
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark" /><span style={{ fontFamily: "ui-serif, Georgia, serif", fontSize: 22, fontWeight: 500 }}>PalPilot</span></div>
        <p className="login-subtitle">{t("login.subtitle")}</p>
        <div className="stack">
          <div className="field">
            <label className="field-label" htmlFor="u">{t("login.username")}</label>
            <input id="u" className="input" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="p">{t("login.password")}</label>
            <input id="p" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </div>
          {err && <div className="field-error" role="alert">{err}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy || retryIn > 0}>
            {busy ? t("login.submitting") : retryIn > 0 ? `${t("login.submit")} (${retryIn}s)` : t("login.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
