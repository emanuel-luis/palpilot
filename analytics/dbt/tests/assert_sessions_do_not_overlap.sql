select * from (
    select
        session_id,
        session_end,
        lead(session_start) over (order by session_start) as next_start
    from {{ ref('int_vm_sessions') }}
)
where next_start < session_end
