-- Counterfactual: the VM runs 24 h every calendar day. The fixed floor is the same either way, so
-- it is left out of the comparison.
with daily as (
    select
        c.usage_date,
        coalesce(u.vm_hours, 0) as actual_vm_hours,
        24.0 as always_on_vm_hours,
        coalesce(u.idle_tail_hours, 0) as idle_tail_hours
    from {{ ref('int_calendar_days') }} c
    left join {{ ref('fct_daily_usage') }} u using (usage_date)
),

rows_ as (
    select 'day' as grain, cast(usage_date as varchar) as row_key, usage_date,
        actual_vm_hours, always_on_vm_hours, idle_tail_hours
    from daily
    union all
    select 'period', 'period', null, sum(actual_vm_hours), sum(always_on_vm_hours), sum(idle_tail_hours)
    from daily
)

select
    *,
    actual_vm_hours * {{ unit_cost('vm_hour_usd') }} as actual_cost_usd,
    always_on_vm_hours * {{ unit_cost('vm_hour_usd') }} as always_on_cost_usd,
    (always_on_vm_hours - actual_vm_hours) * {{ unit_cost('vm_hour_usd') }} as savings_usd,
    (always_on_vm_hours - actual_vm_hours) / always_on_vm_hours as savings_pct,
    idle_tail_hours * {{ unit_cost('vm_hour_usd') }} as idle_tail_cost_usd
from rows_
