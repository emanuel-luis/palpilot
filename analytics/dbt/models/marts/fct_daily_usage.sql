select
    sample_date as usage_date,
    sum(interval_seconds) / 3600.0 as vm_hours,
    sum(case when has_players then interval_seconds else 0 end) / 3600.0 as play_hours,
    sum(coalesce(players, 0) * interval_seconds) / 3600.0 as player_hours,
    coalesce(max(players), 0) as peak_players,
    count(distinct session_id) as sessions,
    sum(case when is_idle_tail then interval_seconds else 0 end) / 3600.0 as idle_tail_hours
from {{ ref('int_sample_intervals') }}
group by sample_date
