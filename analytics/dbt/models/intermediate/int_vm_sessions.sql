select
    session_id,
    min(sampled_at) as session_start,
    max(sampled_at + to_seconds(interval_seconds)) as session_end,
    count(*) as samples,
    sum(interval_seconds) / 60.0 as vm_minutes,
    sum(case when has_players then interval_seconds else 0 end) / 60.0 as play_minutes,
    sum(coalesce(players, 0) * interval_seconds) / 60.0 as player_minutes,
    sum(case when is_idle_tail then interval_seconds else 0 end) / 60.0 as idle_tail_minutes,
    coalesce(max(players), 0) as peak_players
from {{ ref('int_sample_intervals') }}
group by session_id
