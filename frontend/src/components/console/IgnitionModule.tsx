// The Console hero. Not a stat grid — an instrument.
//
// This product exists because the machine is off most of the time and bills by
// the minute, so the hero answers exactly three things: what state is it in, how
// do I flip it, and what is it costing me right now.
//
// Two deliberate pieces:
//   * a four-stage track, because "RUNNING" is a lie the user can feel — the VM
//     reports RUNNING roughly two minutes before the game accepts anyone, and a
//     spinner cannot express that. The track makes the wait legible.
//   * a session cost meter, in cyan (reserved here for live values), derived
//     from uptime. It is the only number on the page that explains the product.
import { useEffect, useMemo, useState } from "react";
import { Copy, Check, Power, RotateCcw, Save, ShieldCheck, Square } from "lucide-react";
import { usePower, useRestartGame } from "@/hooks/queries";
import { session } from "@/stores/session";
import { apiPost } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/Confirm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tip } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { GameState } from "@/components/StatusPills";

// README's São Paulo estimate. Not fetched from anywhere — labelled as an
// estimate in the UI precisely because it is one.
const USD_PER_HOUR = 0.18;

const DASH = "—";

type Stage = { id: string; label: string };
const STAGES: Stage[] = [
  { id: "off", label: "Off" },
  { id: "booting", label: "Booting" },
  { id: "loading", label: "Game loading" },
  { id: "accepting", label: "Accepting players" },
];

function stageIndex(gameState: GameState, vmStatus: string): number {
  const s = (vmStatus || "").toUpperCase();
  if (gameState === "online") return 3;
  if (gameState === "starting") return s === "RUNNING" ? 2 : 1;
  if (gameState === "stopping") return 1;
  return 0;
}

function StageTrack({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-0" aria-label="Startup progress">
      {STAGES.map((stage, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={stage.id} className="flex min-w-0 items-center">
            <div className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-2.5 rounded-full transition-colors duration-slow",
                  done && "bg-ok",
                  active && (current === 3 ? "bg-ok" : "bg-warn animate-breathe"),
                  !done && !active && "bg-line",
                )}
              />
              <span
                className={cn(
                  "text-2xs uppercase tracking-wider transition-colors",
                  active ? "font-semibold text-fg" : done ? "text-muted" : "text-faint",
                )}
              >
                {stage.label}
              </span>
            </div>
            {i < STAGES.length - 1 ? (
              <span
                aria-hidden
                className={cn("mx-2 h-px w-8 shrink-0 sm:w-12", i < current ? "bg-ok/60" : "bg-line")}
              />
            ) : null}
          </li>
        );
      })}
      <li className="sr-only">{`Current stage: ${STAGES[current]?.label ?? "unknown"}`}</li>
    </ol>
  );
}

export function IgnitionModule({
  vmStatus,
  gameState,
  serverName,
  uptime,
  players,
  maxPlayers,
  day,
  ip,
  port,
}: {
  vmStatus: string;
  gameState: GameState;
  serverName?: string;
  uptime: number | null;
  players: number | null;
  maxPlayers: number | null;
  day: number | null;
  ip?: string;
  port?: string;
}) {
  const canPower = session.can("power");
  const canCommands = session.can("commands");
  const canSettings = session.can("settings");
  const power = usePower();
  const restart = useRestartGame();
  const [copied, setCopied] = useState(false);
  const [safeRestarting, setSafeRestarting] = useState(false);

  const online = gameState === "online";
  const busy = gameState === "starting" || gameState === "stopping" || power.isPending;
  const current = stageIndex(gameState, vmStatus);

  const address = ip ? `${ip}:${port || "8211"}` : "";
  const cost = uptime != null ? (uptime / 3600) * USD_PER_HOUR : null;

  // Tick so the uptime and cost readouts move between polls instead of looking frozen.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!online) return;
    const t = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [online]);

  async function onPower() {
    if (!canPower || busy) return;
    if (online) {
      const ok = await confirm({
        title: "Stop the server?",
        message:
          (players ?? 0) > 0
            ? `${players} player(s) are connected. Stopping disconnects them and powers the VM off.`
            : "This powers the VM off. Compute stops billing once it reports TERMINATED.",
        confirmLabel: "Stop server",
        danger: true,
      });
      if (!ok) return;
      const r = await power.mutateAsync("stop");
      if (!r.ok) toast.err(r.error || "Couldn't stop the VM.");
      else toast.ok("Stopping — billing ends once the VM reports TERMINATED.");
      return;
    }
    const r = await power.mutateAsync("start");
    if (!r.ok) toast.err(r.error || "Couldn't start the VM.");
    else toast.ok("Starting. The game accepts players about 2–3 minutes after boot.");
  }

  async function onRestart() {
    const ok = await confirm({
      title: "Restart the game?",
      message: "Connected players are disconnected. The VM stays on, so this does not stop billing.",
      confirmLabel: "Restart",
      danger: true,
    });
    if (!ok) return;
    const r = await restart.mutateAsync();
    if (!r.ok) toast.err(r.error || "Couldn't restart.");
    else toast.ok("Restarting the game process.");
  }

  /** Announce → save → grace → restart. Composed client-side; there is no
   *  single server-side "safe restart" call. */
  async function onSafeRestart() {
    const ok = await confirm({
      title: "Safe restart?",
      message:
        "Players are warned, the world is saved, then the game restarts after a short grace period. " +
        "The VM stays on.",
      confirmLabel: "Safe restart",
    });
    if (!ok) return;
    setSafeRestarting(true);
    try {
      if (canCommands) {
        await apiPost("/api/rest/announce", { message: "Server restarting in 15 seconds — saving now." });
        const saved = await apiPost("/api/rest/save", {});
        if (!saved.ok) {
          toast.err(saved.error || "Couldn't save the world; restart cancelled.");
          return;
        }
        toast.ok("World saved. Restarting in 15 seconds.");
        await new Promise((r) => setTimeout(r, 15_000));
      }
      const r = await restart.mutateAsync();
      if (!r.ok) toast.err(r.error || "Couldn't restart.");
      else toast.ok("Restarted.");
    } finally {
      setSafeRestarting(false);
    }
  }

  async function onSaveWorld() {
    const r = await apiPost("/api/rest/save", {});
    if (!r.ok) toast.err(r.error || "Couldn't save the world.");
    else toast.ok("World saved.");
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Clipboard API needs a secure context; fall back to a scratch textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = address;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch {
        toast.err("Couldn't copy — select the address and copy manually.");
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const gauges = useMemo(
    () => [
      { label: "Players", value: online && players != null ? `${players}/${maxPlayers ?? 0}` : DASH },
      { label: "Uptime", value: online && uptime != null ? formatDuration(uptime) : DASH },
      { label: "In-game day", value: online && day != null ? String(day) : DASH },
    ],
    [online, players, maxPlayers, uptime, day],
  );

  return (
    <Card glass className="overflow-hidden">
      <div className="grid gap-5 p-5 sm:grid-cols-[auto_1fr] sm:gap-6 sm:p-6">
        {/* ------------------------------------------------------ the switch */}
        <div className="flex flex-col items-center gap-3">
          <Tip
            label={
              !canPower
                ? "You don't have permission to power the server."
                : online
                  ? "Stop the server and the VM"
                  : "Start the VM"
            }
          >
            <button
              type="button"
              onClick={onPower}
              disabled={!canPower || busy}
              aria-label={online ? "Stop server" : "Start server"}
              className={cn(
                "relative grid size-28 place-items-center rounded-full transition-all duration-slow ease-out",
                "bg-surface-2 shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4",
                "disabled:cursor-not-allowed disabled:opacity-70",
                !busy && "hover:brightness-110 active:translate-y-px",
                online && "shadow-glow-ok",
                busy && "shadow-glow-warn",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute inset-[-6px] rounded-full border-2 border-transparent",
                  online && "border-ok/50",
                  busy && "border-warn/40 border-t-warn animate-ring-spin",
                )}
              />
              {online ? (
                <Square className="size-8 text-ok" aria-hidden />
              ) : (
                <Power className={cn("size-9", busy ? "text-warn" : "text-muted")} aria-hidden />
              )}
            </button>
          </Tip>
          <span className="text-2xs uppercase tracking-widest text-faint">
            {online ? "Running" : busy ? "Working" : "Powered off"}
          </span>
        </div>

        {/* ------------------------------------------------------ the readout */}
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{serverName || "PalPilot"}</h1>
            <p className="mt-0.5 text-xs text-muted">
              {online
                ? "Accepting players."
                : gameState === "starting"
                  ? "Booting. The game answers about 2–3 minutes after the VM comes up."
                  : gameState === "stopping"
                    ? "Powering down."
                    : "Off. Nothing is billing except the static IP and disks."}
            </p>
          </div>

          <StageTrack current={current} />

          {/* Join address — the single most-copied string in the product. */}
          <button
            type="button"
            onClick={copyAddress}
            disabled={!address}
            className={cn(
              "group flex w-full items-center gap-3 rounded-md border border-dashed border-line px-3 py-2 text-left",
              "transition-colors duration-fast hover:border-signal disabled:cursor-not-allowed disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-label={address ? `Copy server address ${address}` : "Server address unavailable"}
          >
            <span className="eyebrow shrink-0">Address</span>
            <span className="num min-w-0 flex-1 truncate font-mono text-sm">{address || "Unavailable"}</span>
            {copied ? (
              <span className="flex items-center gap-1 text-2xs text-ok"><Check className="size-3" /> copied</span>
            ) : (
              <Copy className="size-3.5 shrink-0 text-faint group-hover:text-signal" aria-hidden />
            )}
          </button>

          <div className="grid grid-cols-2 gap-4 border-t border-dashed border-line pt-4 sm:grid-cols-4">
            {gauges.map((g) => (
              <div key={g.label}>
                <div className="eyebrow">{g.label}</div>
                <div className={cn("num mt-1 font-mono text-xl", !online && "text-faint")}>{g.value}</div>
              </div>
            ))}
            {/* The one number that explains the whole product. Cyan = live. */}
            <div>
              <Tip label={`Estimated at $${USD_PER_HOUR.toFixed(2)}/hour of compute. Stops the moment the VM powers off.`}>
                <div className="eyebrow cursor-help underline decoration-dotted underline-offset-2">
                  This session
                </div>
              </Tip>
              <div className={cn("num mt-1 font-mono text-xl", online ? "text-ion" : "text-faint")}>
                {cost != null && online ? `$${cost.toFixed(2)}` : DASH}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ actions */}
      {(canCommands || canSettings) && online ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 bg-bg/30 px-5 py-3 sm:px-6">
          {canCommands ? (
            <Button variant="secondary" size="sm" onClick={onSaveWorld}>
              <Save /> Save world
            </Button>
          ) : null}
          {canSettings ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={safeRestarting}
                onClick={onSafeRestart}
              >
                <ShieldCheck /> Safe restart
              </Button>
              <Button variant="danger" size="sm" loading={restart.isPending && !safeRestarting} onClick={onRestart}>
                <RotateCcw /> Restart now
              </Button>
            </>
          ) : null}
          <span className="ml-auto text-2xs text-faint">
            Restarting affects the game only — the VM keeps billing.
          </span>
        </div>
      ) : null}
    </Card>
  );
}
