"""landing -> raw: validate every line against the contract, write Parquet and rejects.

Full refresh, so a re-run on the same landing files gives byte-identical output: the run id is a
digest of the input, and a replayed run keeps the ingested_at of its first execution.
"""

import argparse
import hashlib
import json
import shutil
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import duckdb
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from palpilot_analytics import DATA_DIR

Pct = Annotated[float | None, Field(ge=0, le=100)]
NonNeg = Annotated[float | None, Field(ge=0)]


class Sample(BaseModel):
    """Data contract for one line of history.jsonl (panel/panel.py stats_sample).

    Every key is required; an unavailable reading is null, never 0 (null is valid, absent is not).
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    t: Annotated[int, Field(ge=1_672_531_200, le=4_102_444_800)]  # 2023-01-01 .. 2100-01-01
    cpu: Pct
    mem: Pct
    disk: Pct
    rx: NonNeg
    tx: NonNeg
    players: Annotated[int | None, Field(ge=0, le=1000)]
    fps: NonNeg
    frametime: NonNeg
    uptime: NonNeg
    up: bool


COLUMNS = """t BIGINT, cpu DOUBLE, mem DOUBLE, disk DOUBLE, rx DOUBLE, tx DOUBLE, players INTEGER,
    fps DOUBLE, frametime DOUBLE, uptime DOUBLE, up BOOLEAN, source_file VARCHAR, line_no INTEGER,
    run_id VARCHAR, ingested_at TIMESTAMP, dt VARCHAR"""
FIELDS = list(Sample.model_fields)


def _reason(e: ValidationError) -> str:
    return "; ".join(
        "invalid_json"
        if x["type"] == "json_invalid"
        else f"{'.'.join(map(str, x['loc']))}:{x['type']}"
        for x in e.errors()
    )


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def ingest(data: Path) -> dict:
    started = _now()
    stats = data / "landing" / "stats"
    files = sorted((stats / "archive").glob("history-*.jsonl"))
    files += [p for p in (stats / "history.jsonl.1", stats / "history.jsonl") if p.exists()]
    if not files:
        raise SystemExit(f"no landing files under {stats}: run the generator first")

    digest = hashlib.sha256()
    for f in files:
        digest.update(f.relative_to(stats).as_posix().encode() + b"\0" + f.read_bytes())
    run_id = f"run-{digest.hexdigest()[:12]}"
    run_file = data / "_runs" / f"{run_id}.json"
    ingested_at = json.loads(run_file.read_text())["ingested_at"] if run_file.exists() else started

    work = data / ".ingest_tmp"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    con = duckdb.connect()
    con.execute("SET threads = 1")  # single writer: deterministic file layout and row order
    con.execute(f"CREATE TABLE raw ({COLUMNS})")
    rejects, valid, read = [], [], 0
    for f in files:
        name = f.relative_to(stats).as_posix()
        text = f.read_text(encoding="utf-8", errors="replace")
        for line_no, line in enumerate(text.split("\n"), 1):
            if not line.strip():
                continue
            read += 1
            try:
                s = Sample.model_validate_json(line)
            except ValidationError as e:
                rejects.append(
                    {
                        "source_file": name,
                        "line_no": line_no,
                        "reason": _reason(e),
                        "raw": line[:500],
                    }
                )
                continue
            dt = datetime.fromtimestamp(s.t, UTC).strftime("%Y-%m-%d")
            valid.append([*(getattr(s, k) for k in FIELDS), name, line_no, run_id, ingested_at, dt])
    con.executemany(f"INSERT INTO raw VALUES ({','.join('?' * 16)})", valid)
    con.execute(
        f"COPY (SELECT * FROM raw ORDER BY source_file, line_no) TO '{(work / 'history').as_posix()}' "
        "(FORMAT PARQUET, PARTITION_BY (dt), FILENAME_PATTERN 'part')"
    )
    (work / "rejects").mkdir()
    (work / "rejects" / "rejects.jsonl").write_text(
        "".join(json.dumps({**r, "run_id": run_id}) + "\n" for r in rejects), encoding="utf-8"
    )
    con.close()

    for sub, dest in (("history", data / "raw" / "history"), ("rejects", data / "rejects")):
        shutil.rmtree(dest, ignore_errors=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(work / sub, dest)
    shutil.rmtree(work)

    run = {
        "run_id": run_id,
        "ingested_at": ingested_at,
        "started_at": started,
        "finished_at": _now(),
        "files_read": [f.relative_to(stats).as_posix() for f in files],
        "rows_read": read,
        "rows_valid": len(valid),
        "rows_rejected": len(rejects),
        "reject_reasons": dict(Counter(r["reason"] for r in rejects)),
    }
    run_file.parent.mkdir(parents=True, exist_ok=True)
    run_file.write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
    return run


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    r = ingest(ap.parse_args().data)
    print(
        f"{r['run_id']}: read {r['rows_read']}, valid {r['rows_valid']}, rejected "
        f"{r['rows_rejected']} {r['reject_reasons']}"
    )


if __name__ == "__main__":
    main()
