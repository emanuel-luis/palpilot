-- The reporting window, one row per local calendar day: [period_start, period_end). Days without
-- usage are included because the fixed floor and the always-on baseline still accrue on them.
select
    cast(unnest(generate_series(
        cast('{{ var("period_start") }}' as date),
        cast('{{ var("period_end") }}' as date) - 1,
        interval 1 day
    )) as date) as usage_date,
    '{{ var("report_tz") }}' as report_tz
