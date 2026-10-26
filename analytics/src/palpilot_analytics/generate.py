"""Synthetic stats history in the layout the VM agent leaves in the GCS bucket.

The server is offline by choice, so there is no real history to analyse. This simulates what
panel/panel.py would have written: evening play sessions, the VM booting on demand (up=false and
null game fields for a few minutes), one sample every 60 s, and the idle watchdog stopping the VM
after 30 minutes without players. A few defects are injected on purpose so the contract and the
rejects path get exercised. Deterministic: the same arguments give the same bytes.

    landing/stats/archive/history-<ts>.jsonl   rotated generations (archived at rotation)
    landing/stats/history.jsonl.1              last rotated generation (same bytes as the newest archive)
    landing/stats/history.jsonl                live file, last line truncated
"""

import argparse
import json
import random
import shutil
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

from palpilot_analytics import DATA_DIR

LOCAL_OFFSET_S = 3 * 3600  # São Paulo is UTC-3; players are active in the local evening
IDLE_GRACE_MIN = 30  # IDLE_GRACE_SECONDS=1800 in panel/idle_watchdog.py


def _session(rng: random.Random, t0: int, morning: bool) -> list[dict]:
    """One VM run from the start request until the watchdog stops it, one sample per minute."""
    boot = rng.randint(3, 5)
    if morning:
        n_players = 1
    else:
        n_players = 0 if rng.random() < 0.08 else rng.choice([1, 1, 2, 2, 3, 4])
    stays = []  # (join_minute, leave_minute) after the VM started
    for k in range(n_players):
        join = boot + (rng.randint(0, 3) if k == 0 else rng.randint(2, 60))
        stays.append((join, join + rng.randint(30, 150)))
    rows, idle, m = [], 0, 0
    while True:
        t = t0 + m * 60 + rng.randint(-2, 2)
        if m < boot:  # VM is up, game server is not: host metrics only
            rows.append(
                {
                    "t": t,
                    "cpu": round(rng.uniform(55, 90), 1),
                    "mem": round(rng.uniform(15, 30), 1),
                    "disk": 41.2,
                    "rx": round(rng.uniform(5e4, 4e5)),
                    "tx": round(rng.uniform(1e3, 2e4)),
                    "players": None,
                    "fps": None,
                    "frametime": None,
                    "uptime": None,
                    "up": False,
                }
            )
        else:
            p = sum(a <= m < b for a, b in stays)
            idle = idle + 1 if p == 0 else 0
            fps = round(max(5.0, 60 - 2.0 * p - rng.uniform(0, 4)), 1)
            rows.append(
                {
                    "t": t,
                    "cpu": round(min(100.0, 9 + 6 * p + rng.uniform(0, 5)), 1),
                    "mem": round(min(100.0, 34 + 3 * p + (m - boot) * 0.02 + rng.uniform(0, 1)), 1),
                    "disk": 41.2,
                    "rx": round(p * rng.uniform(6e3, 2.5e4) + rng.uniform(0, 500)),
                    "tx": round(p * rng.uniform(2e4, 9e4) + rng.uniform(0, 500)),
                    "players": p,
                    "fps": fps,
                    "frametime": round(1000 / fps, 2),
                    "uptime": (m - boot) * 60 + rng.randint(0, 3),
                    "up": True,
                }
            )
        m += 1
        if m > boot and idle >= IDLE_GRACE_MIN:
            return rows


def _samples(rng: random.Random, start: date, days: int) -> list[dict]:
    rows = []
    for d in range(days):
        midnight = datetime.combine(start + timedelta(days=d), time(), tzinfo=UTC)
        base = int(midnight.timestamp()) + LOCAL_OFFSET_S
        weekend = (start + timedelta(days=d)).weekday() >= 5
        if rng.random() < 0.15:  # lunch-time solo session
            rows += _session(rng, base + rng.randint(11 * 3600 + 1800, 13 * 3600 + 1800), True)
        if rng.random() < (0.9 if weekend else 0.55):
            rows += _session(rng, base + rng.randint(18 * 3600 + 1800, 21 * 3600 + 1800), False)
    return rows


def _lines(rng: random.Random, samples: list[dict]) -> list[str]:
    """Serialise like the agent, then inject the defects the contract has to catch."""
    for i in rng.sample(range(len(samples)), 5):  # host metrics glitch: null readings
        samples[i].update(cpu=None, mem=None, disk=None)
    n = len(samples)
    samples[rng.randrange(n // 10, n // 5)]["cpu"] = 187.3  # out of range
    samples[rng.randrange(n // 5, 3 * n // 10)]["players"] = -1  # out of range
    lines = [json.dumps(s, separators=(",", ":")) for s in samples]
    dup = rng.randrange(3 * n // 10, 2 * n // 5)
    lines.insert(dup, lines[dup])  # duplicated sample
    return lines


def generate(
    out: Path, seed: int = 42, days: int = 30, start: str = "2026-09-01", rotate_lines: int = 2500
):
    rng = random.Random(seed)
    samples = _samples(rng, date.fromisoformat(start), days)
    lines = _lines(rng, samples)
    stats = out / "stats"
    shutil.rmtree(stats, ignore_errors=True)
    (stats / "archive").mkdir(parents=True)
    # panel.py rotates by size; here by line count so a 30-day demo still rotates.
    chunks = [lines[i : i + rotate_lines] for i in range(0, len(lines), rotate_lines)]
    live = chunks.pop()
    for i, chunk in enumerate(chunks):
        # the archive is named after the rotation moment: the first sample of the next generation
        nxt = (chunks + [live])[i + 1]
        ts = datetime.fromtimestamp(json.loads(nxt[0])["t"], UTC).strftime("%Y-%m-%d_%H-%M-%S")
        (stats / "archive" / f"history-{ts}.jsonl").write_bytes(("\n".join(chunk) + "\n").encode())
    if chunks:
        (stats / "history.jsonl.1").write_bytes(("\n".join(chunks[-1]) + "\n").encode())
    last = live[-1]
    live[-1] = last[
        : rng.randint(20, len(last) - 5)
    ]  # crash mid-write: no closing brace or newline
    (stats / "history.jsonl").write_bytes("\n".join(live).encode())
    return len(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--start", default="2026-09-01", help="first local day, YYYY-MM-DD")
    ap.add_argument("--rotate-lines", type=int, default=2500)
    ap.add_argument("--out", type=Path, default=DATA_DIR / "landing")
    a = ap.parse_args()
    n = generate(a.out, a.seed, a.days, a.start, a.rotate_lines)
    print(f"generated {n} lines under {a.out / 'stats'}")


if __name__ == "__main__":
    main()
