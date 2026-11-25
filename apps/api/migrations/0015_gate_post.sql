-- The registration post after the owner's flow of 25 November 2026.

-- 1. Close cargo and flexi bag are marked by the operator of the post when the truck checks in, per truck, and no
--    longer by the transporter on the registration. The registration columns stay as the fallback for trucks
--    registered before this migration, but an outgoing registration may now be sent without them.
alter table trips add column close_cargo boolean;
alter table trips add column flexi_bag boolean;

do $$
declare
    found text;
begin
    select conname into found
    from pg_constraint
    where conrelid = 'registrations'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%close_cargo IS NOT NULL%';
    if found is null then
        raise exception 'The close cargo check on registrations was not found.';
    end if;
    execute format('alter table registrations drop constraint %I', found);
end $$;

-- 2. What the reading service made of each scan of the post. A walk-in built on a scan that was read is ordinary
--    work of the post. One built on a scan that was not read, or on no scan at all, is a typed registration and
--    needs the module below.
create table gate_scans (
    file_id       bigint primary key references files (id),
    direction     text not null check (direction in ('IN', 'OUT')),
    outcome       text not null check (outcome in ('READ', 'UNREADABLE', 'NOT_READ')),
    fields_found  smallint check (fields_found >= 0),
    fields_total  smallint check (fields_total >= 0)
);

-- 3. Typing a registration at the post is the emergency path: the reading service is down, the paper cannot be
--    read, or the scanner is broken. Only an account that holds this module may do it, and it gives a reason.
insert into modules (code, name, sort_order, levels, partner_allowed, is_active) values
    ('gate_emergency', 'Registrasi darurat di pos', 22, array['VIEW'], false, true);
