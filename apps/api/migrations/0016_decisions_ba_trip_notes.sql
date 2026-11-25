-- The owner's answers of 25 November 2026 on the weighbridge decisions and the outgoing truck list.

-- 1. A decision on a plate, gross or tare difference is one of: approve, hold ("mundur/hold": the weighing is
--    not saved and the truck may weigh again) or reject (the truck is turned away: it leaves without being
--    weighed and returns its card at the post). A net difference of an incoming truck has no reject. Both hold
--    and reject are stored as status REJECTED; decision_code tells them apart. Rows decided before this
--    migration (REJECTED, no code) were holds.
do $$
declare
    found record;
begin
    for found in
        select conname from pg_constraint
        where conrelid = 'exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%decision_code%'
    loop
        execute format('alter table exceptions drop constraint %I', found.conname);
    end loop;
end $$;

alter table exceptions add constraint exceptions_decision_code_values
    check (decision_code in ('OK', 'ADD_LOAD', 'REDUCE_LOAD', 'HOLD', 'REJECT'));
alter table exceptions add constraint exceptions_decision_code_type
    check (decision_code is null or (type = 'NET_OUT') = (decision_code in ('OK', 'ADD_LOAD', 'REDUCE_LOAD')));
alter table exceptions add constraint exceptions_retry_code
    check (status <> 'RETRY' or decision_code in ('ADD_LOAD', 'REDUCE_LOAD'));
alter table exceptions add constraint exceptions_rejected_code
    check (decision_code not in ('HOLD', 'REJECT') or status = 'REJECTED');

-- 2. Free text the transporter may add per outgoing truck: an extra SPBE, and a passport or delivery letter number.
alter table trips add column extra_spbe text;
alter table trips add column passport_no text;
