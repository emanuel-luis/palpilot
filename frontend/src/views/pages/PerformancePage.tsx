// Host + game telemetry, backed by GET /api/metrics/host (added alongside this
// redesign) and the metrics already in /api/overview.
//
// Two honesty rules the whole page obeys:
//   * a reading the server returns as null renders as "—", never as 0. An idle
//     machine and an unknown machine are different facts.
//   * history exists only while this tab is open. Nothing is stored server-side,
//     so the charts say so rather than implying retained history.
//
// There is no TPS anywhere: Palworld reports server FPS and frame time, not a
// tick rate. Showing a "TPS" number would mean inventing one.
import { useOverview, isOffline } from "@/hooks/queries";
import { useHostMetrics, useTelemetryHistory } from "@/hooks/useTelemetry";
import { deriveGameState } from "@/components/StatusPills";
import { PageHeader, OfflineNotice } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";

const DASH = "—";

function pct(v: number | null | undefined) {
  return v == null ? DASH : `${v.toFixed(1)}%`;
}

/** A value with a proportional bar. The bar is omitted when the value is unknown,
 *  so an empty track never reads as "zero". */
function Meter({
  label, value, percent, hint, tone = "signal",
}: {
  label: string;
  value: string;
  percent: number | null | undefined;
  hint?: string;
  tone?: "signal" | "ion" | "warn";
}) {
  const over = percent != null && percent >= 90;
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="eyebrow">{label}</span>
          {over ? <Badge tone="warn">high</Badge> : null}
        </div>
        <div className="num font-mono text-2xl">{value}</div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          {percent != null ? (
            <div
              className={cn(
                "h-full rounded-full transition-all duration-slow ease-out",
                over ? "bg-warn" : tone === "ion" ? "bg-ion" : "bg-signal",
              )}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          ) : null}
        </div>
        {hint ? <p className="text-2xs text-faint">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Inline sparkline. Hand-rolled SVG rather than a chart library: a 120-point
 *  single series does not justify ~300kB of Recharts in a bundle that has to be
 *  downloaded before the console can boot. */
function Spark({
  points, label, unit, tone = "ion", max,
}: {
  points: (number | null)[];
  label: string;
  unit?: string;
  tone?: "ion" | "signal";
  max?: number;
}) {
  const clean = points.filter((p): p is number => p != null);
  const latest = clean.length ? clean[clean.length - 1] : null;
  const peak = max ?? (clean.length ? Math.max(...clean) : 1);
  const ceiling = peak <= 0 ? 1 : peak;
  const w = 100;
  const h = 28;
  const d = clean.length
    ? clean
        .map((v, i) => {
          const x = clean.length === 1 ? w : (i / (clean.length - 1)) * w;
          const y = h - (v / ceiling) * h;
          return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ")
    : "";
  const stroke = tone === "ion" ? "hsl(var(--ion))" : "hsl(var(--signal))";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span className="num font-mono text-sm">
          {latest == null ? DASH : `${Math.round(latest)}${unit ?? ""}`}
        </span>
      </div>
      {clean.length > 1 ? (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
          <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="flex h-7 items-center text-2xs text-faint">Collecting…</div>
      )}
    </div>
  );
}

export function PerformancePage() {
  const overview = useOverview();
  const metricsQ = useHostMetrics();

  const body: any = overview.data?.data || {};
  const vm = body.vm || {};
  const server = body.server;
  const gameMetrics = server?.metrics;
  const gameState = deriveGameState(vm.status || "", !!server?.info);
  const online = gameState === "online";

  const host = !isOffline(metricsQ.data) ? (metricsQ.data as any) : undefined;
  const { history } = useTelemetryHistory(
    host,
    gameMetrics?.currentplayernum ?? null,
    gameMetrics?.serverfps ?? null,
  );

  if (!online && !host) {
    return (
      <>
        <PageHeader title="Performance" description="CPU, memory, disk and network on the VM, plus game frame timing." />
        <OfflineNotice action="see performance" />
      </>
    );
  }

  if (metricsQ.isLoading && !host) {
    return (
      <>
        <PageHeader title="Performance" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      </>
    );
  }

  const net = host?.network;
  const rx = net?.rx_bytes_per_sec;
  const tx = net?.tx_bytes_per_sec;

  return (
    <>
      <PageHeader
        title="Performance"
        description="Read live from the VM. History is kept only while this tab is open — nothing is stored server-side."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Meter
          label="CPU"
          value={pct(host?.cpu?.percent)}
          percent={host?.cpu?.percent}
          hint={
            host?.cpu
              ? `${host.cpu.cores} cores · load ${host.cpu.load1 ?? DASH}`
              : undefined
          }
        />
        <Meter
          label="Memory"
          value={pct(host?.memory?.percent)}
          percent={host?.memory?.percent}
          hint={
            host?.memory
              ? `${formatBytes(host.memory.used)} of ${formatBytes(host.memory.total)}`
              : undefined
          }
        />
        <Meter
          label="Data disk"
          value={pct(host?.disk?.percent)}
          percent={host?.disk?.percent}
          hint={host?.disk ? `${formatBytes(host.disk.free)} free — worlds, mods and backups` : undefined}
        />
        <Card>
          <CardContent className="space-y-2">
            <span className="eyebrow">Network</span>
            <div className="num font-mono text-lg">
              <span className="text-ion">↓ {rx == null ? DASH : `${formatBytes(rx)}/s`}</span>
            </div>
            <div className="num font-mono text-lg">
              <span className="text-signal">↑ {tx == null ? DASH : `${formatBytes(tx)}/s`}</span>
            </div>
            <p className="text-2xs text-faint">
              {net ? `${formatBytes(net.rx_bytes)} in · ${formatBytes(net.tx_bytes)} out since boot` : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Game</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Tip label="Frames per second inside the server simulation. Palworld does not report a tick rate.">
                  <span className="eyebrow cursor-help underline decoration-dotted underline-offset-2">Server FPS</span>
                </Tip>
                <div className="num mt-1 font-mono text-xl">
                  {gameMetrics?.serverfps != null ? Math.round(gameMetrics.serverfps) : DASH}
                </div>
              </div>
              <div>
                <span className="eyebrow">Frame time</span>
                <div className="num mt-1 font-mono text-xl">
                  {gameMetrics?.serverframetime != null ? `${gameMetrics.serverframetime.toFixed(1)}ms` : DASH}
                </div>
              </div>
              <div>
                <span className="eyebrow">Players</span>
                <div className="num mt-1 font-mono text-xl">
                  {gameMetrics ? `${gameMetrics.currentplayernum ?? 0}/${gameMetrics.maxplayernum ?? 0}` : DASH}
                </div>
              </div>
              <div>
                <span className="eyebrow">Game uptime</span>
                <div className="num mt-1 font-mono text-xl">
                  {gameMetrics?.uptime != null ? formatDuration(gameMetrics.uptime) : DASH}
                </div>
              </div>
            </div>
            {host?.host_uptime != null ? (
              <p className="text-2xs text-faint">
                VM up {formatDuration(host.host_uptime)} · game service{" "}
                {host.service_active ? "running" : "stopped"}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <Badge tone="neutral">{history.length} samples this session</Badge>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <Spark label="CPU" unit="%" max={100} points={history.map((h) => h.cpu)} />
            <Spark label="Memory" unit="%" max={100} points={history.map((h) => h.mem)} tone="signal" />
            <Spark label="Players" points={history.map((h) => h.players)} tone="signal" />
            <Spark label="Server FPS" points={history.map((h) => h.fps)} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
