-- Phase 4: weighing, exceptions and their decisions, field steps, card return and reports
-- (docs/fase-4-rancangan.md).

-- The modules of this phase can now be granted. The dashboard stays off until its phase.
update modules set is_active = true
where code in ('weighbridge', 'approvals', 'security_check', 'qc', 'qc_approvals', 'unloading', 'loading', 'sealing', 'reports');

-- The PIN that opens manual plate entry on the weighbridge program. Only an argon2 hash is stored. After a
-- number of wrong attempts in a row the PIN is locked for a while; a right PIN resets the count.
alter table stations add column pin_hash text;
alter table stations add column pin_failed_count smallint not null default 0 check (pin_failed_count >= 0);
alter table stations add column pin_locked_until timestamptz;
-- when the current machine key (api_key_hash) was made; the key itself is shown once and never stored
alter table stations add column key_created_at timestamptz;

-- The weighbridge that raised an exception: the weighing saved on approval is recorded at that station, and
-- only that station may send its heartbeat or cancel it.
alter table exceptions add column station_id integer references stations (id);

-- Every weigh request the weighbridge program sent, with the answer it got. A request sent again with the
-- same request_id gets the stored answer instead of being weighed twice. Rows with result PLATE_RETRY also
-- count the plate attempts of one weighing step.
create table weighbridge_requests (
    station_id    integer not null references stations (id),
    request_id    text not null check (request_id ~ '^[A-Za-z0-9._:-]{8,64}$'),
    trip_id       bigint references trips (id),
    trip_step_id  bigint references trip_steps (id),
    result        text not null check (result in ('SAVED', 'PENDING', 'PLATE_RETRY')),
    status_code   smallint not null,
    response      jsonb not null,
    created_at    timestamptz not null default now(),
    primary key (station_id, request_id)
);
create index weighbridge_requests_step_idx on weighbridge_requests (trip_step_id, result);
