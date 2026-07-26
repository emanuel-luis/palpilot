import { useState } from "react";
import { Ban, LogOut } from "lucide-react";
import { apiPost } from "@/lib/api";
import { session } from "@/stores/session";
import { toast } from "./ui/Toast";
import { prompt } from "./ui/Confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Tip } from "@/components/ui/tooltip";
import { t } from "@/i18n/en";

type Player = {
  name?: string;
  level?: number;
  ping?: number;
  userId?: string;
  playerId?: string;
};

const idOf = (p: Player) => p.userId || p.playerId || "";

export function PlayersTable({ players, serverOn }: { players: Player[]; serverOn: boolean }) {
  const canCmd = session.can("commands");
  const [busy, setBusy] = useState<string | null>(null);

  // Two distinct empty states: the server is up and nobody's on, vs it's off.
  if (!serverOn) return <p className="py-8 text-center text-sm text-faint">{t("console.players.offline")}</p>;

  async function moderate(action: "kick" | "ban", p: Player) {
    const userid = idOf(p);
    if (!userid) { toast.err(t("console.players.noUserId")); return; }
    const label = action === "kick" ? t("commands.kick") : t("commands.ban");
    // One dialog: the consequence sentence and the reason field together, rather
    // than a native prompt followed by a styled confirm.
    const reason = await prompt({
      title: label,
      message:
        action === "kick"
          ? t("console.players.confirmKick", { name: p.name ?? userid })
          : t("console.players.confirmBan", { name: p.name ?? userid }),
      input: { label: t("console.players.reason"), required: false },
      confirmLabel: label,
      danger: true,
    });
    if (reason === null) return;
    setBusy(`${action}-${userid}`);
    const r = await apiPost(`/api/rest/${action}`, { userid, message: reason });
    setBusy(null);
    if (!r.ok) toast.err(r.error || t("console.players.failed", { action: label }));
    else toast.ok(t("console.players.done", { action: label, name: p.name ?? userid }));
  }

  const columns: Column<Player>[] = [
    {
      key: "name",
      header: t("console.players.name"),
      sortable: true,
      value: (p) => p.name ?? "",
      cell: (p) => <span className="font-medium">{p.name || "—"}</span>,
    },
    {
      key: "level",
      header: t("console.players.level"),
      sortable: true,
      align: "right",
      mono: true,
      width: "88px",
      value: (p) => p.level ?? null,
    },
    {
      key: "ping",
      header: t("console.players.ping"),
      sortable: true,
      align: "right",
      mono: true,
      width: "96px",
      value: (p) => p.ping ?? null,
      cell: (p) => {
        if (p.ping == null) return "—";
        const ms = Math.round(p.ping);
        // Colour is a hint, the number is the fact.
        const tone = ms < 80 ? "ok" : ms < 160 ? "warn" : "danger";
        return <Badge tone={tone}>{ms} ms</Badge>;
      },
    },
    {
      key: "id",
      header: t("console.players.playerId"),
      mono: true,
      secondary: true,
      value: (p) => idOf(p),
      cell: (p) => idOf(p) || "—",
    },
  ];

  return (
    <DataTable
      rows={players}
      columns={columns}
      rowKey={(p) => idOf(p) || (p.name ?? Math.random().toString(36))}
      searchable={players.length > 8}
      searchPlaceholder="Search players"
      pageSize={players.length > 25 ? 25 : 0}
      caption="Players currently connected"
      empty={t("console.players.empty")}
      actions={
        canCmd
          ? (p) => {
              const userid = idOf(p);
              if (!userid) {
                return <span className="text-2xs text-faint">{t("console.players.noUserId")}</span>;
              }
              return (
                <>
                  <Tip label={`Kick ${p.name ?? userid}`}>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `kick-${userid}`}
                      onClick={() => moderate("kick", p)}
                    >
                      <LogOut /> {t("commands.kick")}
                    </Button>
                  </Tip>
                  <Tip label={`Ban ${p.name ?? userid}`}>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === `ban-${userid}`}
                      onClick={() => moderate("ban", p)}
                    >
                      <Ban /> {t("commands.ban")}
                    </Button>
                  </Tip>
                </>
              );
            }
          : undefined
      }
    />
  );
}
