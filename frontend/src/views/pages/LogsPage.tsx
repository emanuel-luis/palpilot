// Log terminal, backed by GET /api/logs (cursor-based tail, added alongside this
// redesign — see panel.py).
//
// Honest about what it is: polling, not a socket. So there is no fake "connected"
// indicator; the live badge reflects whether polling is actually running.
//
// Rendering is windowed by hand rather than with a virtualisation library: the
// buffer is capped at 4000 lines and only the visible slice is mounted, which is
// enough to keep scrolling smooth without shipping another dependency.
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Search, Trash2 } from "lucide-react";
import { useLogStream, useBootLogStream } from "@/hooks/useTelemetry";
import { PageHeader, OfflineNotice } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { isNotable, isPollNoise, parseLogLine, type LogSource } from "@/lib/logs";

const ROW_HEIGHT = 20; // must match leading-5 below
const OVERSCAN = 20;

/** Colour by severity only — no attempt at full syntax highlighting, which on
 *  Unreal logs produces confetti rather than meaning. */
function toneFor(line: string): string {
  if (/\b(error|fatal|exception|failed|refused)\b/i.test(line)) return "text-danger";
  if (/\bwarn(ing)?\b/i.test(line)) return "text-warn";
  if (/\b(display|info|log[A-Z])/.test(line)) return "text-fg/80";
  return "text-muted";
}

/** One colour per origin, so the eye can separate "the game said" from "the
 *  agent said" without reading the label every time. */
const SOURCE_TONE: Record<LogSource, string> = {
  startup: "text-signal",
  game: "text-ok",
  agent: "text-fg/70",
  systemd: "text-warn",
  system: "text-faint",
  raw: "text-faint",
};

/** A parsed row: time and origin in fixed columns, message taking the rest. */
function LogRow({ text }: { text: string }) {
  const p = parseLogLine(text);
  const notable = isNotable(text);
  return (
    <div className="flex h-5 gap-2 whitespace-pre" title={text}>
      <span className="w-14 shrink-0 text-faint">{p.time}</span>
      <span className={cn("w-16 shrink-0 truncate", SOURCE_TONE[p.source])}>{p.label}</span>
      <span className={cn("truncate", notable ? "text-fg" : toneFor(p.message))}>
        {p.message}
      </span>
    </div>
  );
}

/** Which log we're reading. `boot` is the VM's serial console (startup script,
 *  systemd units, the game-version reconcile, PalServer's own stdout); `game` is
 *  the Unreal log tree on the data disk. Only one polls at a time. */
type Source = "game" | "boot";

function SourceTabs({ source, onChange }: { source: Source; onChange: (s: Source) => void }) {
  const tabs: { id: Source; label: string; hint: string }[] = [
    { id: "game", label: "Game server", hint: "Unreal's own log from the data disk. Needs the VM running." },
    {
      id: "boot",
      label: "VM boot & system",
      hint: "Serial console: provisioning, systemd units, the game-version reconcile. Readable while the VM boots.",
    },
  ];
  return (
    <div className="mt-4 flex gap-1" role="tablist" aria-label="Log source">
      {tabs.map((t) => (
        <Tip key={t.id} label={t.hint}>
          <button
            role="tab"
            aria-selected={source === t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              source === t.id
                ? "bg-signal/12 font-medium text-fg"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {t.label}
          </button>
        </Tip>
      ))}
    </div>
  );
}

export function LogsPage() {
  const [source, setSource] = useState<Source>("game");
  const gameLog = useLogStream(source === "game");

  // This Palworld build writes no log file -- Pal/Saved/Logs does not even exist
  // on the VM -- because the dedicated server logs to stdout, which systemd sends
  // to the journal. That output IS in the serial console, so rather than leaving
  // the tab permanently empty, the game view falls back to the game-tagged lines
  // of the boot stream. Same content, no infrastructure change.
  const journalFallback = source === "game" && !gameLog.files.length;
  const bootLog = useBootLogStream(source === "boot" || journalFallback);
  const log = source === "boot" || journalFallback ? bootLog : gameLog;
  const baseLines = useMemo(
    () =>
      journalFallback
        ? bootLog.lines.filter((l) => parseLogLine(l.text).source === "game")
        : log.lines,
    [journalFallback, bootLog.lines, log.lines],
  );
  const [filter, setFilter] = useState("");
  // On by default: a quiet server's log is ~90% poll chatter, and a first-time
  // view full of "REST accessed endpoint /v1/api/players OK" teaches nothing.
  const [hideNoise, setHideNoise] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(480);

  // Noise filtering happens before the text filter so the "N hidden" count means
  // "hidden as noise", not "didn't match your search".
  const denoised = useMemo(
    () => (hideNoise ? baseLines.filter((l) => !isPollNoise(l.text)) : baseLines),
    [baseLines, hideNoise],
  );
  const noiseHidden = baseLines.length - denoised.length;

  const rows = useMemo(() => {
    if (!filter.trim()) return denoised;
    const needle = filter.toLowerCase();
    return denoised.filter((l) => l.text.toLowerCase().includes(needle));
  }, [denoised, filter]);

  // Follow the tail unless the user has scrolled away or paused.
  useEffect(() => {
    if (!autoScroll || log.paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, autoScroll, log.paused]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    // Re-arm auto-scroll only when the user returns to the bottom themselves.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  }

  function download() {
    const blob = new Blob([log.text()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = source === "boot" ? "palworld-vm-boot" : log.file || "palworld";
    a.download = `${base}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Only the GAME log needs the VM up. The boot log deliberately keeps rendering
  // while the VM is off/booting — that is when you most want to read it — so it
  // gets an inline note instead of taking over the page.
  if (source === "game" && log.offline) {
    return (
      <>
        <PageHeader title="Logs" description="Output from the Palworld server process." />
        <SourceTabs source={source} onChange={setSource} />
        <div className="mt-4">
          <OfflineNotice action="read the game log" />
        </div>
      </>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const slice = rows.slice(first, last);

  return (
    <>
      <PageHeader
        title="Logs"
        description={
          source === "game"
            ? "Output from the Palworld server process, tailed from the VM. Polled, not streamed."
            : "The VM's boot story: provisioning, systemd units, the game-version reconcile and the server's own startup. Read from the serial console, so it works while the VM is still booting."
        }
        actions={
          <>
            <Tip label={log.paused ? "Resume polling" : "Pause polling — nothing is fetched while paused"}>
              <Button variant="secondary" size="sm" onClick={() => log.setPaused(!log.paused)}>
                {log.paused ? <Play /> : <Pause />}
                {log.paused ? "Resume" : "Pause"}
              </Button>
            </Tip>
            <Tip label="Download everything currently buffered">
              <Button variant="secondary" size="sm" onClick={download} disabled={!log.lines.length}>
                <Download /> Download
              </Button>
            </Tip>
            <Tip label="Clear the view. The file on the VM is untouched.">
              <Button variant="ghost" size="sm" onClick={log.clear} disabled={!log.lines.length}>
                <Trash2 /> Clear
              </Button>
            </Tip>
          </>
        }
      />

      <SourceTabs source={source} onChange={setSource} />

      <Card className="mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line/60 px-4 py-2.5">
          <Badge tone={log.paused ? "neutral" : "live"} dot pulse={!log.paused}>
            {log.paused ? "Paused" : "Live"}
          </Badge>

          {log.files.length > 1 ? (
            <select
              className="h-8 rounded-md border border-line bg-surface-2 px-2 text-xs"
              value={log.file}
              onChange={(e) => log.selectFile(e.target.value)}
              aria-label="Log file"
            >
              {log.files.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-xs text-faint">{log.file || "—"}</span>
          )}

          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter lines"
              aria-label="Filter log lines"
              className="h-8 w-44 rounded-md border border-line bg-surface-2 pl-7 pr-2 text-xs placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/* Never silently drop output: the count says exactly how much is
              hidden, and one click brings it back. */}
          <Tip label="Health polling: the console asks the server for info/metrics/players every few seconds, and each poll writes a line from both the game and the agent. Hidden by default because it crowds out everything else.">
            <button
              onClick={() => setHideNoise(!hideNoise)}
              aria-pressed={hideNoise}
              className={cn(
                "rounded-md px-2 py-1 text-2xs transition-colors duration-fast",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                hideNoise ? "bg-surface-2 text-muted" : "text-faint hover:text-fg",
              )}
            >
              {hideNoise ? `Polling hidden${noiseHidden ? ` (${noiseHidden})` : ""}` : "Polling shown"}
            </button>
          </Tip>

          <span className="num font-mono text-2xs text-faint">
            {filter ? `${rows.length}/${denoised.length}` : rows.length} lines
          </span>
        </div>

        {log.error ? (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            Couldn't read the log: {log.error}
          </div>
        ) : null}

        {/* Say where these lines come from: the tab promises the game log, and
            this is the game's stdout by way of the VM console, not a file. */}
        {journalFallback && bootLog.available ? (
          <div className="border-b border-line/60 bg-surface-2/60 px-4 py-2 text-xs text-muted">
            This server's Palworld writes no log file, so this is its output read from the VM console.
            History is limited to the console buffer.
          </div>
        ) : null}

        {(source === "boot" || journalFallback) && !bootLog.available ? (
          <div className="border-b border-line/60 bg-surface-2/60 px-4 py-2 text-xs text-muted">
            {bootLog.vmStatus && bootLog.vmStatus !== "RUNNING"
              ? `The VM is ${bootLog.vmStatus.toLowerCase()} — the serial console only exists while it runs. Start the server and the boot log appears here live.`
              : "Waiting for the VM's serial console…"}
          </div>
        ) : null}

        {/* GCP's serial buffer is a ring, so very long uptimes lose the earliest
            boot lines. Better to admit the hole than imply a complete log. */}
        {source === "boot" && bootLog.gap ? (
          <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
            Some earlier output aged out of the VM's serial buffer, so this view starts mid-stream.
          </div>
        ) : null}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scroll-y h-[min(62vh,640px)] bg-bg/60 px-4 py-3 font-mono text-xs leading-5"
          role="log"
          aria-live="off"
          aria-label="Server log output"
        >
          {log.loading && !rows.length ? (
            <p className="text-faint">Reading the log…</p>
          ) : !rows.length ? (
            <p className="text-faint">
              {filter ? (
                "No lines match that filter."
              ) : noiseHidden > 0 ? (
                // Everything received so far was poll chatter. Say that, instead
                // of implying the log is empty.
                <>
                  Nothing but health polling so far ({noiseHidden} lines).{" "}
                  <button className="underline hover:text-fg" onClick={() => setHideNoise(false)}>
                    Show it
                  </button>
                </>
              ) : journalFallback ? (
                // Falling back to the console already; nothing tagged `game` has
                // come through yet (a freshly started server, or a quiet one).
                <>
                  No game output in the console buffer yet.{" "}
                  <button className="underline hover:text-fg" onClick={() => setSource("boot")}>
                    See the full boot log
                  </button>
                </>
              ) : (
                "No output yet."
              )}
            </p>
          ) : (
            // Spacer divs above/below keep the scrollbar honest while only the
            // visible slice is mounted.
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
              <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
                {slice.map((l) => (
                  <LogRow key={l.id} text={l.text} />
                ))}
              </div>
            </div>
          )}
        </div>

        {!autoScroll && !log.paused ? (
          <div className="border-t border-line/60 px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAutoScroll(true);
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              Jump to latest
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
