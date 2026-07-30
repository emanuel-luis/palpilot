// Telemetry: host metrics (with an in-tab history buffer for charts) and the
// incremental log stream.
//
// Two honest limits, both surfaced rather than hidden:
//   * Nothing is stored server-side, so chart history exists only while the tab
//     is open. `history` starts empty and fills as polls land.
//   * The log endpoint is cursor-based, not a socket. `rotated` means the file
//     shrank (restart/rotation) and the buffer is cleared instead of showing a
//     gap that would read as missing output.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { session, useSession } from "@/stores/session";
import { isOffline } from "./queries";

// --------------------------------------------------------------- host metrics

export type HostMetrics = {
  cpu: { percent: number | null; cores: number; load1: number | null; load5: number | null; load15: number | null };
  memory: { total: number; used: number; available: number; percent: number | null };
  disk: { path: string; total: number; used: number; free: number; percent: number | null };
  network: {
    rx_bytes: number; tx_bytes: number;
    rx_bytes_per_sec: number | null; tx_bytes_per_sec: number | null;
  };
  host_uptime: number | null;
  service_active: boolean;
};

export function useHostMetrics(intervalMs = 5000) {
  const s = useSession();
  return useQuery({
    queryKey: ["metrics", "host"],
    queryFn: () => apiGet<any>("/api/metrics/host").then((r) => {
      if (r.status === 503 && (r.data as any)?.error === "vm_offline") {
        return { offline: true as const, vmStatus: (r.data as any)?.status || "TERMINATED" };
      }
      if (!r.ok) return Promise.reject(r);
      return r.data as HostMetrics;
    }),
    enabled: s.authed && s.ready && session.can("view"),
    refetchInterval: intervalMs,
    staleTime: 1000,
  });
}

export type Sample = {
  t: number;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
  players: number | null;
  fps: number | null;
};

/**
 * Ring buffer of samples for the live charts. Deliberately in-memory: there is
 * no time-series store behind this, and inventing one client-side that survives
 * reloads would imply history the server doesn't have.
 */
export function useTelemetryHistory(
  metrics: HostMetrics | undefined,
  players: number | null,
  fps: number | null,
  capacity = 120,
) {
  const [history, setHistory] = useState<Sample[]>([]);
  // Only append when a genuinely new reading arrives, not on every render.
  const lastRef = useRef<string>("");

  useEffect(() => {
    if (!metrics) return;
    const key = `${metrics.cpu.percent}|${metrics.memory.percent}|${metrics.network.rx_bytes}|${players}|${fps}`;
    if (key === lastRef.current) return;
    lastRef.current = key;
    setHistory((prev) => {
      const next: Sample = {
        t: Date.now(),
        cpu: metrics.cpu.percent,
        mem: metrics.memory.percent,
        rx: metrics.network.rx_bytes_per_sec,
        tx: metrics.network.tx_bytes_per_sec,
        players,
        fps,
      };
      const out = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice();
      out.push(next);
      return out;
    });
  }, [metrics, players, fps, capacity]);

  const reset = useCallback(() => {
    lastRef.current = "";
    setHistory([]);
  }, []);

  return { history, reset };
}

// ----------------------------------------------------------------- log stream

export type LogLine = { id: number; text: string };

type LogResponse = {
  file: string;
  files: { name: string; size: number; modified: number }[];
  cursor: number;
  size: number;
  lines: string[];
  rotated: boolean;
  truncated: boolean;
};

export type LogStream = {
  lines: LogLine[];
  files: { name: string; size: number; modified: number }[];
  file: string;
  paused: boolean;
  offline: boolean;
  error: string | null;
  loading: boolean;
  setPaused: (v: boolean) => void;
  selectFile: (name: string) => void;
  clear: () => void;
  /** Everything currently buffered, for the download control. */
  text: () => string;
};

/**
 * Poll `/api/logs` forward from a cursor and accumulate. Pausing stops the
 * polling entirely rather than buffering invisibly — a paused terminal that
 * silently keeps fetching is a memory leak the user can't see.
 */
export function useLogStream(enabled: boolean, intervalMs = 3000, capacity = 4000): LogStream {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [files, setFiles] = useState<LogResponse["files"]>([]);
  const [file, setFile] = useState("");
  const [paused, setPaused] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const cursorRef = useRef(-1);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const clear = useCallback(() => {
    setLines([]);
    cursorRef.current = -1;
  }, []);

  const selectFile = useCallback((name: string) => {
    setFile(name);
    setLines([]);
    cursorRef.current = -1;
  }, []);

  const poll = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const q = new URLSearchParams();
      if (file) q.set("name", file);
      q.set("cursor", String(cursorRef.current));
      const r = await apiGet<any>("/api/logs", { query: q.toString() });

      if (r.status === 503 && (r.data as any)?.error === "vm_offline") {
        setOffline(true);
        setError(null);
        return;
      }
      setOffline(false);
      if (!r.ok) {
        setError(r.error || "log_read_failed");
        return;
      }
      setError(null);
      const d = r.data as LogResponse;
      setFiles(d.files || []);
      if (!file && d.file) setFile(d.file);

      // The cursor is stale because the file was truncated: start clean rather
      // than splicing new output onto output that no longer exists.
      if (d.rotated) setLines([]);

      if (d.lines?.length) {
        setLines((prev) => {
          const add = d.lines.map((text) => ({ id: seqRef.current++, text }));
          const merged = d.rotated ? add : prev.concat(add);
          return merged.length > capacity ? merged.slice(merged.length - capacity) : merged;
        });
      }
      cursorRef.current = d.cursor;
    } catch {
      setError("network_error");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [file, capacity]);

  useEffect(() => {
    if (!enabled || paused) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    let cancelled = false;
    setLoading(cursorRef.current < 0);

    const tick = async () => {
      await poll();
      if (cancelled) return;
      timerRef.current = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, paused, poll, intervalMs]);

  const text = useCallback(() => lines.map((l) => l.text).join("\n"), [lines]);

  return {
    lines, files, file, paused, offline, error, loading,
    setPaused, selectFile, clear, text,
  };
}

// ------------------------------------------------------- boot / system log
//
// GET /api/vm/serial is coordinator-owned, not proxied to the agent: the whole
// point is to see the boot BEFORE the agent is answering (and to read the last
// boot while the VM is off). So this never reports `offline` the way the game log
// does — it reports `available: false` plus the VM state, which is information,
// not a failure.

type SerialResponse = {
  contents: string;
  start: number;
  next: number;
  vm_status: string;
  available: boolean;
};

export type BootLogStream = LogStream & { vmStatus: string; available: boolean; gap: boolean };

export function useBootLogStream(enabled: boolean, intervalMs = 4000, capacity = 4000): BootLogStream {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [vmStatus, setVmStatus] = useState("");
  const [available, setAvailable] = useState(false);
  const [gap, setGap] = useState(false);

  const nextRef = useRef(0);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const clear = useCallback(() => {
    setLines([]);
    setGap(false);
    // Deliberately NOT resetting the offset: the log on the VM is untouched, so
    // clearing the view then re-fetching everything would contradict the button.
  }, []);

  const poll = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const q = new URLSearchParams({ start: String(nextRef.current) });
      const r = await apiGet<any>("/api/vm/serial", { query: q.toString() });
      if (!r.ok) {
        setError(r.error || "serial_read_failed");
        return;
      }
      setError(null);
      const d = r.data as SerialResponse;
      setVmStatus(d.vm_status || "");
      setAvailable(!!d.available);

      // GCP's serial buffer is a ring: if it dropped output we asked for, the
      // returned `start` is ahead of our offset. Say so rather than presenting a
      // seamless log with a silent hole in it.
      if (typeof d.start === "number" && d.start > nextRef.current && nextRef.current > 0) setGap(true);

      if (d.contents) {
        const incoming = d.contents.replace(/\r/g, "").split("\n");
        // A chunk can end mid-line; drop the trailing empty from a clean split.
        if (incoming.length && incoming[incoming.length - 1] === "") incoming.pop();
        if (incoming.length) {
          setLines((prev) => {
            const add = incoming.map((text) => ({ id: seqRef.current++, text }));
            const merged = prev.concat(add);
            return merged.length > capacity ? merged.slice(merged.length - capacity) : merged;
          });
        }
      }
      if (typeof d.next === "number") nextRef.current = d.next;
    } catch {
      setError("network_error");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [capacity]);

  useEffect(() => {
    if (!enabled || paused) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    let cancelled = false;
    setLoading(nextRef.current === 0);

    const tick = async () => {
      await poll();
      if (cancelled) return;
      timerRef.current = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, paused, poll, intervalMs]);

  const text = useCallback(() => lines.map((l) => l.text).join("\n"), [lines]);

  return {
    lines,
    files: [],
    file: "serial console",
    paused,
    offline: false,
    error,
    loading,
    setPaused,
    selectFile: () => {},
    clear,
    text,
    vmStatus,
    available,
    gap,
  };
}

export { isOffline };
