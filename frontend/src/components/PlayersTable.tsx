import { useState } from "react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { prompt } from "./ui/Confirm";
import { t } from "@/i18n/en";

export function PlayersTable({ players, serverOn }: { players: any[]; serverOn: boolean }) {
  const canCmd = session.can("commands");
  const [busy, setBusy] = useState<string | null>(null);

  // Two distinct empty states: the server is up and nobody's on, vs it's off.
  if (!serverOn) return <div className="empty">{t("console.players.offline")}</div>;
  if (!players.length) return <div className="empty">{t("console.players.empty")}</div>;

  async function moderate(action: "kick" | "ban", p: any) {
    const userid = p.userId || p.playerId;
    if (!userid) { toast.err(t("console.players.noUserId")); return; }
    const label = action === "kick" ? t("commands.kick") : t("commands.ban");
    // One dialog: the consequence sentence and the reason field together, rather
    // than a native prompt followed by a styled confirm.
    const reason = await prompt({
      title: label,
      message: action === "kick"
        ? t("console.players.confirmKick", { name: p.name })
        : t("console.players.confirmBan", { name: p.name }),
      input: { label: t("console.players.reason"), required: false },
      confirmLabel: label,
      danger: true,
    });
    if (reason === null) return;
    setBusy(`${action}-${userid}`);
    const r = await apiPost(`/api/rest/${action}`, { userid, message: reason });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("console.players.failed", { action: label }));
    else toast.ok(t("console.players.done", { action: label, name: p.name }));
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{t("console.players.name")}</th>
            <th>{t("console.players.level")}</th>
            <th>{t("console.players.playerId")}</th>
            <th>{t("console.players.ping")}</th>
            {canCmd && <th style={{ width: 160 }}>{t("console.players.actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const userid = p.userId || p.playerId;
            return (
              <tr key={userid || `row-${i}`}>
                <td>{p.name || "—"}</td>
                <td className="mono">{p.level ?? "—"}</td>
                <td className="mono" style={{ fontSize: 12 }}>{userid || "—"}</td>
                <td className="mono">{p.ping != null ? Math.round(p.ping) : "—"}</td>
                {canCmd && (
                  <td>
                    {userid ? (
                      <div className="row-tight">
                        <button
                          className="btn btn-sm"
                          disabled={busy === `kick-${userid}`}
                          onClick={() => moderate("kick", p)}
                        >{t("commands.kick")}</button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy === `ban-${userid}`}
                          onClick={() => moderate("ban", p)}
                        >{t("commands.ban")}</button>
                      </div>
                    ) : (
                      <span className="field-hint">{t("console.players.noUserId")}</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
