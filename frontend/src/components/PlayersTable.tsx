import { useState } from "react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { confirm } from "./ui/Confirm";
import { t } from "@/i18n/en";

export function PlayersTable({ players, serverOn }: { players: any[]; serverOn: boolean }) {
  const canCmd = session.can("commands");
  const [busy, setBusy] = useState<string | null>(null);

  if (!serverOn) return <div className="empty">{t("console.players.serverOff")}</div>;
  if (!players.length) return <div className="empty">{t("console.players.none")}</div>;

  async function moderate(action: "kick" | "ban", p: any) {
    const label = action === "kick" ? t("commands.kick") : t("commands.ban");
    const reason = window.prompt(t("console.players.reasonPrompt", { action: label }), action);
    if (reason === null) return;
    const ok = await confirm({ message: t("console.players.confirm", { action: label, name: p.name }), confirmLabel: label, danger: true });
    if (!ok) return;
    setBusy(`${action}-${p.userId}`);
    const r = await apiPost(`/api/rest/${action}`, { userid: p.userId, message: reason });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("console.players.fail", { action: label }));
    else toast.ok(t("console.players.done", { action: label, name: p.name }));
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{t("console.players.name")}</th>
            <th>{t("console.players.level")}</th>
            <th>{t("console.players.userId")}</th>
            <th>{t("console.players.ping")}</th>
            {canCmd && <th style={{ width: 160 }}>{t("console.players.actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.userId}>
              <td>{p.name}</td>
              <td className="mono">{p.level ?? "—"}</td>
              <td className="mono" style={{ fontSize: 12 }}>{p.userId}</td>
              <td className="mono">{p.ping != null ? Math.round(p.ping) : "—"}</td>
              {canCmd && (
                <td>
                  <div className="row-tight">
                    <button className="btn btn-sm" disabled={busy === `kick-${p.userId}`} onClick={() => moderate("kick", p)}>{t("commands.kick")}</button>
                    <button className="btn btn-sm btn-danger" disabled={busy === `ban-${p.userId}`} onClick={() => moderate("ban", p)}>{t("commands.ban")}</button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
