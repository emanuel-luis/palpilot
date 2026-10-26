-- One row per sample instant. The same sample can reach raw twice (the newest archive and
-- history.jsonl.1 are the same generation, and the agent can double-append): keep the first
-- occurrence in file order.
with ranked as (
    select
        *,
        row_number() over (partition by t order by source_file, line_no) as rn
    from {{ source('raw', 'history') }}
)

select
    epoch_ms(t * 1000) as sampled_at,
    cast(epoch_ms(t * 1000) as date) as sample_date,
    cpu as cpu_pct,
    mem as mem_pct,
    disk as disk_pct,
    rx as rx_bytes_per_s,
    tx as tx_bytes_per_s,
    cast(players as integer) as players,
    fps,
    frametime as frametime_ms,
    uptime as game_uptime_s,
    "up" as game_up,
    source_file,
    line_no,
    run_id,
    ingested_at
from ranked
where rn = 1
