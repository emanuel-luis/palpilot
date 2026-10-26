-- Every calendar day of the period, also the days the VM never ran (the fixed floor still accrues).
select cast(unnest(generate_series(min(sample_date), max(sample_date), interval 1 day)) as date) as usage_date
from {{ ref('int_sample_intervals') }}
