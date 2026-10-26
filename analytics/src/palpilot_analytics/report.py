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

    u = one(
        "SELECT min(usage_date) AS first, max(usage_date) AS last, count(*) AS n FROM fct_daily_usage"
    )
    c = one("SELECT * FROM fct_cost_per_play_hour WHERE grain = 'period'")
    s = one("SELECT * FROM fct_idle_shutdown_savings WHERE grain = 'period'")
    return "\n".join(
        [
            f"Usage and cost {u['first']} .. {u['last']} ({u['n']} days with usage; synthetic data)",
            f"  VM hours                {c['vm_hours']:8.1f}",
            f"  Play hours (>=1 player) {c['play_hours']:8.1f}",
            f"  Player hours            {c['player_hours']:8.1f}",
            f"  Total cost              ${c['total_cost_usd']:7.2f}  (VM ${c['variable_cost_usd']:.2f}"
            f" + fixed ${c['fixed_cost_usd']:.2f})",
            f"  Cost per play-hour      ${c['cost_per_play_hour_usd']:7.2f}",
            f"  Cost per player-hour    ${c['cost_per_player_hour_usd']:7.2f}",
            f"  Savings vs always-on    ${s['savings_usd']:7.2f}  ({s['savings_pct']:.1%} of "
            f"${s['always_on_cost_usd']:.2f})",
            f"  Idle-grace tails        {s['idle_tail_hours']:8.1f} h = ${s['idle_tail_cost_usd']:.2f}",
            f"Marts exported to {out}",
        ]
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    print(report(ap.parse_args().data))


if __name__ == "__main__":
    main()
