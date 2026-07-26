import { useEffect, useState } from "react";
import { useWatchdog, useSaveWatchdog } from "@/hooks/queries";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { t } from "@/i18n/en";

export function WatchdogSection() {
  const q = useWatchdog();
  const m = useSaveWatchdog();
  const canWrite = session.can("watchdog");
  const [poll, setPoll] = useState(60);
  const [grace, setGrace] = useState(30);

  useEffect(() => {
    if (q.data) { setPoll(q.data.poll_seconds); setGrace(Math.round(q.data.grace_seconds / 60)); }
  }, [q.data]);

  if (q.isLoading) return <div className="field-hint">{t("common.loading")}</div>;
  if (q.error) return <div className="empty">{t("watchdog.loadFailed")} <button className="btn btn-sm" onClick={() => q.refetch()}>{t("common.retry")}</button></div>;

  async function save() {
    if (poll < 10 || poll > 3600) { toast.err(t("watchdog.pollRange")); return; }
    if (grace < 1 || grace > 1440) { toast.err(t("watchdog.graceRange")); return; }
    const r = await m.mutateAsync({ poll_seconds: poll, grace_seconds: grace * 60 });
    if (!r.ok) toast.err(r.error || t("watchdog.saveFailed"));
    else toast.ok(t("watchdog.saved"));
  }

  return (
    <div className="stack">
      <div className="field-hint">{t("watchdog.hint")}</div>
      <div className="row">
        <div className="field" style={{ maxWidth: 200 }}>
          <label className="field-label">{t("watchdog.poll")}</label>
          <input className="input mono" type="number" min={10} max={3600} value={poll} onChange={(e) => setPoll(Number(e.target.value) || 0)} disabled={!canWrite} />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label className="field-label">{t("watchdog.grace")}</label>
          <input className="input mono" type="number" min={1} max={1440} value={grace} onChange={(e) => setGrace(Number(e.target.value) || 0)} disabled={!canWrite} />
        </div>
      </div>
      <div className="field-hint mono">{t("watchdog.summary", { poll, grace })}</div>
      {canWrite && <div><button className="btn btn-primary" onClick={save} disabled={m.isPending}>{t("watchdog.save")}</button></div>}
    </div>
  );
}
