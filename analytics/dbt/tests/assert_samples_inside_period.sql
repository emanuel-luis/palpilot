-- Samples outside [period_start, period_end) in report_tz would silently fall off the marts
-- (their days are not in the calendar). Fail instead: widen the window or fix the input.
select sampled_at, sample_date
from {{ ref('int_sample_intervals') }}
where sample_date < cast('{{ var("period_start") }}' as date)
   or sample_date >= cast('{{ var("period_end") }}' as date)
