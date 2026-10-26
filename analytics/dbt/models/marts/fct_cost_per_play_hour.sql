with daily as (
    select
        c.usage_date,
        coalesce(u.vm_hours, 0) as vm_hours,
        coalesce(u.play_hours, 0) as play_hours,
        coalesce(u.player_hours, 0) as player_hours
    from {{ ref('int_calendar_days') }} c
    left join {{ ref('fct_daily_usage') }} u using (usage_date)
),

costed as (
    select
        *,
        vm_hours * {{ unit_cost('vm_hour_usd') }} as variable_cost_usd,
        {{ unit_cost('fixed_monthly_usd') }} / {{ unit_cost('proration_days_per_month') }} as fixed_cost_usd
    from daily
),

rows_ as (
    select 'day' as grain, cast(usage_date as varchar) as row_key, usage_date,
        vm_hours, play_hours, player_hours, variable_cost_usd, fixed_cost_usd
    from costed
    union all
    select 'period', 'period', null, sum(vm_hours), sum(play_hours), sum(player_hours),
        sum(variable_cost_usd), sum(fixed_cost_usd)
    from costed
)

select
    *,
    variable_cost_usd + fixed_cost_usd as total_cost_usd,
    (variable_cost_usd + fixed_cost_usd) / nullif(play_hours, 0) as cost_per_play_hour_usd,
    (variable_cost_usd + fixed_cost_usd) / nullif(player_hours, 0) as cost_per_player_hour_usd
from rows_
