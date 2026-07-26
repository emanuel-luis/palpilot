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
import { useLogStream } from "@/hooks/useTelemetry";
import { PageHeader, OfflineNotice } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

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

export function LogsPage() {
  const log = useLogStream(true);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(480);

  const rows = useMemo(() => {
    if (!filter.trim()) return log.lines;
    const needle = filter.toLowerCase();
    return log.lines.filter((l) => l.text.toLowerCase().includes(needle));
  }, [log.lines, filter]);

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
    a.download = `${log.file || "palworld"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (log.offline) {
    return (
      <>
        <PageHeader title="Logs" description="Output from the Palworld server process." />
        <OfflineNotice action="read logs" />
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
        description="Output from the Palworld server process, tailed from the VM. Polled, not streamed."
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

      <Card className="overflow-hidden">
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

          <span className="num font-mono text-2xs text-faint">
            {filter ? `${rows.length}/${log.lines.length}` : log.lines.length} lines
          </span>
        </div>

        {log.error ? (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            Couldn't read the log: {log.error}
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
              {filter ? "No lines match that filter." : "No output yet."}
            </p>
          ) : (
            // Spacer divs above/below keep the scrollbar honest while only the
            // visible slice is mounted.
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
              <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
                {slice.map((l) => (
                  <div
                    key={l.id}
                    className={cn("h-5 whitespace-pre truncate", toneFor(l.text))}
                    title={l.text}
                  >
                    {l.text}
                  </div>
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
