import hashlib
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import pytest
from pydantic import ValidationError

from palpilot_analytics.generate import generate
from palpilot_analytics.ingest import Sample, ingest
from palpilot_analytics.report import report

DBT_DIR = Path(__file__).resolve().parents[1] / "dbt"
GOOD = {
    "t": 1788000000,
    "cpu": 12.5,
    "mem": 40.0,
    "disk": 41.2,
    "rx": 100.0,
    "tx": 200.0,
    "players": 2,
    "fps": 58.0,
    "frametime": 17.2,
    "uptime": 600,
    "up": True,
}


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_generator_is_deterministic(tmp_path):
    generate(tmp_path / "a", seed=7, days=5, rotate_lines=200)
    generate(tmp_path / "b", seed=7, days=5, rotate_lines=200)
    generate(tmp_path / "c", seed=8, days=5, rotate_lines=200)
    assert tree_hashes(tmp_path / "a") == tree_hashes(tmp_path / "b")
    assert tree_hashes(tmp_path / "a") != tree_hashes(tmp_path / "c")


def test_contract_accepts_nulls_and_rejects_defects():
    Sample.model_validate(GOOD)
    Sample.model_validate({**GOOD, "cpu": None, "players": None, "fps": None, "up": False})
    for bad, field in [
        ({**GOOD, "cpu": 187.3}, "cpu"),
        ({**GOOD, "players": -1}, "players"),
        ({**GOOD, "t": 12}, "t"),
        ({**GOOD, "mem": "40"}, "mem"),
        ({**GOOD, "extra": 1}, "extra"),
        ({k: v for k, v in GOOD.items() if k != "up"}, "up"),
    ]:
        with pytest.raises(ValidationError) as e:
            Sample.model_validate(bad)
        assert e.value.errors()[0]["loc"] == (field,)


def test_ingest_rejects_each_injected_defect_with_reason(tmp_path):
    generate(tmp_path / "landing", seed=1, days=30, rotate_lines=2500)
    run = ingest(tmp_path)
    reasons = run["reject_reasons"]
    assert reasons["invalid_json"] == 1  # truncated last line
    assert reasons["cpu:less_than_equal"] >= 1
    assert reasons["players:greater_than_equal"] >= 1
    assert run["rows_read"] == run["rows_valid"] + run["rows_rejected"]
    rejects = [json.loads(x) for x in (tmp_path / "rejects/rejects.jsonl").read_text().splitlines()]
    assert len(rejects) == run["rows_rejected"]
    assert {"source_file", "line_no", "reason", "raw", "run_id"} <= rejects[0].keys()
    meta = json.loads((tmp_path / "_runs" / f"{run['run_id']}.json").read_text())
    assert meta["rows_valid"] == run["rows_valid"]
    # null readings are valid rows, not rejects
    nulls = duckdb.connect().execute(
        f"select count(*) from read_parquet('{tmp_path.as_posix()}/raw/history/*/*.parquet') "
        "where cpu is null"
    )
    assert nulls.fetchone()[0] > 0


def test_ingest_is_idempotent(tmp_path):
    generate(tmp_path / "landing", seed=3, days=6, rotate_lines=250)
    ingest(tmp_path)
    first = tree_hashes(tmp_path / "raw") | tree_hashes(tmp_path / "rejects")
    ingest(tmp_path)
    assert tree_hashes(tmp_path / "raw") | tree_hashes(tmp_path / "rejects") == first
    assert len(list((tmp_path / "_runs").glob("*.json"))) == 1


TZ = ZoneInfo("America/Sao_Paulo")
START, DAYS = "2026-09-01", 5
END = (date.fromisoformat(START) + timedelta(days=DAYS)).isoformat()


def expected_totals(landing: Path) -> dict:
    """Mart totals computed straight from the landing files, without dbt or DuckDB.

    The window is fixed by START/DAYS in São Paulo local time, not derived from the data.
    """
    by_t = {}
    for f in sorted((landing / "stats").rglob("history*")):
        for line in f.read_text().split("\n"):
            try:
                s = Sample.model_validate_json(line)
            except ValidationError:
                continue
            by_t.setdefault(s.t, s)
    ts = sorted(by_t)
    local = lambda t: datetime.fromtimestamp(t, TZ).date()  # noqa: E731
    first, last = date.fromisoformat(START), date.fromisoformat(END)
    assert all(first <= local(t) < last for t in ts), "generator left the window"
    vm_s = play_s = player_s = 0
    per_day = {}
    for i, t in enumerate(ts):
        nxt = ts[i + 1] - t if i + 1 < len(ts) else None
        w = nxt if nxt is not None and nxt <= 300 else 60
        p = by_t[t].players or 0
        vm_s += w
        play_s += w if p >= 1 else 0
        player_s += p * w
        per_day[local(t).isoformat()] = per_day.get(local(t).isoformat(), 0) + w / 3600
    var = vm_s / 3600 * 0.18
    return {
        "vm_hours": vm_s / 3600,
        "play_hours": play_s / 3600,
        "player_hours": player_s / 3600,
        "total_cost_usd": var + DAYS * 14 / 30,
        "savings_usd": DAYS * 24 * 0.18 - var,
        "per_day": per_day,
    }


def test_end_to_end_marts_match_python(tmp_path):
    generate(tmp_path / "landing", seed=11, days=DAYS, start=START, rotate_lines=300)
    ingest(tmp_path)
    env = {**os.environ, "ANALYTICS_DATA": tmp_path.as_posix()}
    cmd = [
        sys.executable,
        "-c",
        "import sys; from dbt.cli.main import cli; cli()",
        "build",
        "--no-partial-parse",
        "--project-dir",
        str(DBT_DIR),
        "--profiles-dir",
        str(DBT_DIR),
        "--target-path",
        str(tmp_path / "dbt_target"),
        "--log-path",
        str(tmp_path / "dbt_logs"),
        "--vars",
        json.dumps({"period_start": START, "period_end": END}),
    ]
    done = subprocess.run(cmd, env=env, capture_output=True, text=True)
    assert done.returncode == 0, done.stdout[-3000:]

    con = duckdb.connect(str(tmp_path / "palpilot.duckdb"), read_only=True)
    cost = con.execute("select * from fct_cost_per_play_hour where grain = 'period'")
    got = dict(zip([d[0] for d in cost.description], cost.fetchone(), strict=True))
    savings = con.execute(
        "select savings_usd from fct_idle_shutdown_savings where grain = 'period'"
    )
    got["savings_usd"] = savings.fetchone()[0]
    days = dict(
        con.execute("select cast(usage_date as varchar), vm_hours from fct_daily_usage").fetchall()
    )
    assert con.execute("select count(*) from int_calendar_days").fetchone()[0] == DAYS
    con.close()
    want = expected_totals(tmp_path / "landing")
    for k, v in want.items():
        if k != "per_day":
            assert got[k] == pytest.approx(v, rel=1e-9), k
    assert days == pytest.approx(want["per_day"])
    assert got["cost_per_play_hour_usd"] == pytest.approx(
        want["total_cost_usd"] / want["play_hours"]
    )

    text = report(tmp_path)
    assert "Cost per play-hour" in text
    assert (tmp_path / "marts" / "fct_daily_usage.parquet").exists()


def test_report_prints_na_when_there_are_no_play_hours(tmp_path):
    con = duckdb.connect(str(tmp_path / "palpilot.duckdb"))
    con.execute(
        "create table int_calendar_days as select date '2026-09-01' usage_date, 'X/Y' report_tz"
    )
    con.execute("create table fct_daily_usage as select date '2026-09-01' usage_date, 'day' grain")
    con.execute(
        "create table fct_cost_per_play_hour as select 'period' grain, 1.0 vm_hours, 0.0 play_hours, "
        "0.0 player_hours, 0.18 variable_cost_usd, 0.47 fixed_cost_usd, 0.65 total_cost_usd, "
        "null::double cost_per_play_hour_usd, null::double cost_per_player_hour_usd"
    )
    con.execute(
        "create table fct_idle_shutdown_savings as select 'period' grain, 4.2 savings_usd, "
        "0.9 savings_pct, 4.4 always_on_cost_usd, 1.0 idle_tail_hours, 0.18 idle_tail_cost_usd"
    )
    con.close()
    text = report(tmp_path)
    assert "Cost per play-hour      n/a" in text
