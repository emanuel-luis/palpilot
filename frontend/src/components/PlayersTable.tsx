import { t } from "@/i18n/en";
import { session } from "@/stores/session";
import { confirm } from "./ui/Confirm";
import { toast } from "./ui/Toast";
import { apiPost } from "@/lib/api";

interface Player { name: string; playerId: string; userId: string; ip: string; ping: number; level: number; }

export function PlayersTable({ players, serverOn }: { players: Player[]; serverOn: boolean }) {
  const canMod = session.can("commands");

  async function kick(p: Player) {
    const ok = await confirm({ message: t("console.players.confirmKick", { name: p.name }), confirmLabel: t("console.players.kick"), danger: true });
    if (!ok) return;
    const uid = p.userId || p.playerId;
    const r = await apiPost("/api/rest/kick", { userid: uid, message: "kicked" });
    if (!r.ok) toast.err(r.error || t("commands.fail"));
    else toast.ok(t("commands.ok", { cmd: "kick" }));
  }
  async function ban(p: Player) {
    const ok = await confirm({ message: t("console.players.confirmBan", { name: p.name }), confirmLabel: t("console.players.ban"), danger: true });
    if (!ok) return;
    const uid = p.userId || p.playerId;
    const r = await apiPost("/api/rest/ban", { userid: uid, message: "banned" });
    if (!r.ok) toast.err(r.error || t("commands.fail"));
    else toast.ok(t("commands.ok", { cmd: "ban" }));
  }

  if (!serverOn) return <div className="empty">{t("console.players.offline")}</div>;
  if (!players || players.length === 0) return <div className="empty">{t("console.players.empty")}</div>;

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{t("console.players.name")}</th>
            <th style={{ width: 70 }}>{t("console.players.level")}</th>
            <th style={{ width: 80 }}>{t("console.players.ping")}</th>
            <th className="mono" style={{ width: 160 }}>{t("console.players.playerId")}</th>
            {canMod && <th style={{ width: 160 }}>{t("console.players.actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.playerId}>
              <td>{p.name}</td>
              <td className="mono">{p.level}</td>
              <td className="mono">{p.ping} ms</td>
              <td className="mono" title={p.userId || p.playerId} style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.userId || p.playerId}
              </td>
              {canMod && (
                <td>
                  {p.userId ? (
                    <div className="row-tight">
                      <button className="btn btn-sm" onClick={() => kick(p)}>{t("console.players.kick")}</button>
                      <button className="btn btn-sm btn-danger" onClick={() => ban(p)}>{t("console.players.ban")}</button>
                    </div>
                  ) : (
                    <span className="field-hint" title={t("console.players.noUserId")}>—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
