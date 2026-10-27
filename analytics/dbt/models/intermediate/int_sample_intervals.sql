-- Gaps and islands over the samples. A sample covers the time up to the next one when that gap is
-- within the session threshold, else one sample period (the VM stopped right after it).
with gaps as (
    select
        *,
        epoch(sampled_at) - epoch(lag(sampled_at) over (order by sampled_at)) as gap_before_s,
        epoch(lead(sampled_at) over (order by sampled_at)) - epoch(sampled_at) as gap_after_s
    from {{ ref('stg_history_samples') }}
),

numbered as (
    select
        *,
        sum(case when gap_before_s is null or gap_before_s > {{ var('session_gap_seconds') }} then 1 else 0 end)
            over (order by sampled_at rows unbounded preceding) as session_id
    from gaps
),

weighted as (
    select
        *,
        cast(
            case
                when gap_after_s <= {{ var('session_gap_seconds') }} then gap_after_s
                else {{ var('sample_seconds') }}
            end as bigint
        ) as interval_seconds,
        coalesce(players, 0) >= 1 as has_players,
        max(case when coalesce(players, 0) >= 1 then sampled_at end) over (partition by session_id) as last_play_at
    from numbered
)

select
    session_id,
    sampled_at,
    cast(timezone('{{ var("report_tz") }}', timezone('UTC', sampled_at)) as date) as sample_date,
    players,
    interval_seconds,
    has_players,
    -- everything after the last sample with a player (the whole session if nobody ever joined)
    (last_play_at is null or sampled_at > last_play_at) as is_idle_tail
from weighted
