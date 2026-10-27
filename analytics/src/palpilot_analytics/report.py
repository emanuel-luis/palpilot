"""Serving: print the headline numbers and export the marts as Parquet."""

import argparse
from pathlib import Path

import duckdb

from palpilot_analytics import DATA_DIR

MARTS = ("fct_daily_usage", "fct_cost_per_play_hour", "fct_idle_shutdown_savings")


def report(data: Path) -> str:
    con = duckdb.connect(str(data / "palpilot.duckdb"), read_only=True)
    con.execute("SET threads = 1")
    out = data / "marts"
    out.mkdir(parents=True, exist_ok=True)
    for m in MARTS:
        dest = (out / f"{m}.parquet").as_posix()
        con.execute(f"COPY (SELECT * FROM {m} ORDER BY 1, 2) TO '{dest}' (FORMAT PARQUET)")

    def one(sql: str) -> dict:
        cur = con.execute(sql)
        return dict(zip([d[0] for d in cur.description], cur.fetchone(), strict=True))

    w = one(
        "SELECT min(usage_date) AS first, max(usage_date) AS last, count(*) AS n, "
        "any_value(report_tz) AS tz FROM int_calendar_days"
    )
    c = one("SELECT * FROM fct_cost_per_play_hour WHERE grain = 'period'")
    s = one("SELECT * FROM fct_idle_shutdown_savings WHERE grain = 'period'")

    def n(v, spec: str = ".2f", prefix: str = "") -> str:  # null (no play hours) prints n/a
        return "n/a" if v is None else f"{prefix}{v:{spec}}"

    return "\n".join(
        [
            f"Usage and cost {w['first']} .. {w['last']} ({w['n']} days, {w['tz']}; synthetic data)",
            f"  VM hours                {n(c['vm_hours'], '.1f')}",
            f"  Play hours (>=1 player) {n(c['play_hours'], '.1f')}",
            f"  Player hours            {n(c['player_hours'], '.1f')}",
            f"  Total cost              {n(c['total_cost_usd'], prefix='$')}"
            f"  (VM {n(c['variable_cost_usd'], prefix='$')} + fixed {n(c['fixed_cost_usd'], prefix='$')})",
            f"  Cost per play-hour      {n(c['cost_per_play_hour_usd'], prefix='$')}",
            f"  Cost per player-hour    {n(c['cost_per_player_hour_usd'], prefix='$')}",
            f"  Savings vs always-on    {n(s['savings_usd'], prefix='$')}"
            f"  ({n(s['savings_pct'], '.1%')} of {n(s['always_on_cost_usd'], prefix='$')})",
            f"  Idle-grace tails        {n(s['idle_tail_hours'], '.1f')} h = "
            f"{n(s['idle_tail_cost_usd'], prefix='$')}",
            f"Marts exported to {out}",
        ]
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    print(report(ap.parse_args().data))


if __name__ == "__main__":
    main()
