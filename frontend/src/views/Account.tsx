import { useState } from "react";
import { apiPost } from "@/lib/api";
import { session, useSession } from "@/stores/session";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/Confirm";
import { t } from "@/i18n/en";

export function AccountView() {
  const s = useSession();
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [cf, setCf] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (nw.length < 8) { toast.err(t("account.tooShort")); return; }
    if (nw !== cf) { toast.err(t("account.mismatch")); return; }
    setBusy(true);
    const r = await apiPost("/api/account/password", { old: cur, new: nw });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) toast.err(t("account.wrongCurrent"));
      else if (r.status === 400) toast.err(t("account.tooShort"));
      else toast.err(r.error || t("account.changeFailed"));
      return;
    }
    toast.ok(t("account.changed"));
    setTimeout(() => session.clear(), 1200);
  }

  async function signOutAll() {
    const ok = await confirm({ message: t("account.signOutAllConfirm"), confirmLabel: t("account.signOutAll"), danger: true });
    if (!ok) return;
    const r = await apiPost("/api/logout-all");
    if (!r.ok) toast.err(r.error || t("account.signOutAllFailed"));
    else { toast.ok(t("account.signOutAllDone")); setTimeout(() => session.clear(), 800); }
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 520 }}>
      <h1>{t("account.title")}</h1>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("header.signedInAs", { user: s.user })}</div></div>
        <div className="panel-body"><div className="field-hint">{s.perms.length ? s.perms.join(" · ") : "—"}</div></div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("account.passwordTitle")}</div></div>
        <div className="panel-body">
          <p className="field-hint" style={{ marginBottom: 14 }}>{t("account.passwordHint")}</p>
          <form onSubmit={submit} className="stack">
            <div className="field"><label className="field-label">{t("account.current")}</label>
              <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
            <div className="field"><label className="field-label">{t("account.new")}</label>
              <input className="input" type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} required /></div>
            <div class-name="field"><label className="field-label">{t("account.confirm")}</label>
              <input className="input" type="password" autoComplete="new-password" value={cf} onChange={(e) => setCf(e.target.value)} required /></div>
            <div><button className="btn btn-primary" type="submit" disabled={busy}>{t("account.submit")}</button></div>
          </form>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("account.sessionsTitle")}</div></div>
        <div className="panel-body">
          <p className="field-hint" style={{ marginBottom: 14 }}>{t("account.sessionsHint")}</p>
          <button className="btn btn-danger" onClick={signOutAll}>{t("account.signOutAll")}</button>
        </div>
      </div>
    </div>
  );
}
