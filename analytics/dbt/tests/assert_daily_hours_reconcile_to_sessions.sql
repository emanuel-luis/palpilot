-- Daily marts and the session table are two aggregations of the same samples: they must agree.
select d.vm_hours, s.vm_hours as session_vm_hours, d.play_hours, s.play_hours as session_play_hours
from (select sum(vm_hours) as vm_hours, sum(play_hours) as play_hours from {{ ref('fct_daily_usage') }}) d,
     (select sum(vm_minutes) / 60.0 as vm_hours, sum(play_minutes) / 60.0 as play_hours
      from {{ ref('int_vm_sessions') }}) s
where abs(d.vm_hours - s.vm_hours) > 1e-6 or abs(d.play_hours - s.play_hours) > 1e-6
