// Making the VM's serial output readable.
//
// Raw lines carry ~60 characters of boilerplate before the message:
//
//   2026-07-30T19:33:30.001447+00:00 palworld-tf-vm python[3814]: INFO: ...
//
// At a terminal width that leaves almost no room for the part that matters, and
// every line looks identical. So the prefix is split off and rendered as two
// narrow columns (time, source) with the message given the remaining space.
//
// Parsing is deliberately forgiving: anything that doesn't match falls back to
// the raw line rather than being dropped or mangled. Kernel lines (`[    3.03]
// systemd[1]: …`) and bare console output both hit that path.

export type LogSource = "startup" | "game" | "agent" | "systemd" | "system" | "raw";

export type ParsedLine = {
  /** HH:MM:SS, or "" when the line carries no timestamp. */
  time: string;
  source: LogSource;
  /** Short column label. */
  label: string;
  message: string;
};

// <iso-timestamp> <host> <unit>[<pid>]: <message>
const SYSLOG = /^(\S+)\s+\S+\s+([A-Za-z0-9_.\-]+)(?:\[(\d+)\])?:\s?(.*)$/;

const SOURCES: { test: RegExp; source: LogSource; label: string }[] = [
  // The startup script: provisioning, the game-version reconcile, boot summary.
  { test: /^google_metadata_script_runner$/, source: "startup", label: "startup" },
  { test: /^PalServer\.sh$/, source: "game", label: "game" },
  // panel.py runs under uvicorn, which logs as plain `python`.
  { test: /^python[0-9.]*$/, source: "agent", label: "agent" },
  { test: /^systemd/, source: "systemd", label: "systemd" },
];

export function parseLogLine(raw: string): ParsedLine {
  const m = SYSLOG.exec(raw);
  if (!m) {
    return { time: "", source: "raw", label: "", message: raw };
  }
  const [, ts, unit, , message] = m;
  // Keep only wall-clock time: the date is the same for everything on screen and
  // sub-second precision is noise for a human reading a boot.
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(ts)?.[1] || "";
  const hit = SOURCES.find((s) => s.test.test(unit));
  return {
    time,
    source: hit?.source ?? "system",
    label: hit?.label ?? unit.replace(/Agent$/, "").toLowerCase().slice(0, 9),
    message: tidy(message),
  };
}

/** Strip what the time column already shows.
 *
 *  Palworld prefixes its own `[2026-07-30 19:33:30]`, uvicorn pads `INFO:` with
 *  spaces, and the GCE agents repeat an ISO timestamp inside the message. All of
 *  it is duplicated context that pushes the actual content off the line. */
function tidy(message: string): string {
  return message
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, "")
    .replace(/^(INFO|WARNING|ERROR):\s+/, (_m, lvl) => (lvl === "INFO" ? "" : `${lvl}: `))
    .trim();
}

// Health-poll chatter. The console polls the overview every few seconds and the
// watchdog polls for players every minute; each poll writes one line from the
// game and one from the agent. It is ~90% of a quiet server's log and says
// nothing a human wants — but it is REAL output, so it is hidden behind a toggle
// with a count rather than discarded.
const NOISE: RegExp[] = [
  // Palworld's own REST access log for the endpoints we poll.
  /\[LOG\] REST accessed endpoint \/v1\/api\/(info|metrics|players)\b/,
  // uvicorn's access log for the same, proxied through the agent.
  /"GET \/api\/(rest\/(info|metrics|players)|metrics\/host|overview)[^"]*"\s+2\d\d\b/,
  // The watchdog's own heartbeat.
  /\[watchdog\] (empty for|REST unreachable|start:)/,
  // GCE guest agents talking about themselves.
  /OSConfigAgent Info: (Writing inventory|No patch)/,
  /Writing inventory to guest attributes/,
];

export function isPollNoise(raw: string): boolean {
  return NOISE.some((re) => re.test(raw));
}

/** Lines worth spotting in a wall of boot output. */
export function isNotable(raw: string): boolean {
  return (
    /game-sync:|Reconciling the Palworld game version|Started palworld|Stopping palworld|Setup completed|Finished running startup scripts/.test(
      raw,
    ) || /\b(error|fatal|failed|refused|denied|timed out)\b/i.test(raw)
  );
}
