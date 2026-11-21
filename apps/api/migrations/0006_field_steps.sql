-- Phase 5: the field forms of the phones (seal check, QC, reseal, unloading, cleanliness, QC loading, loading,
-- sealing), the plant masters they choose from, and their documents (docs/fase-5-rancangan.md).

-- Storage tanks and the seal stock are kept by the plant, not by logistics.
insert into modules (code, name, sort_order, levels, partner_allowed, is_active) values
    ('plant_masters', 'Master pabrik', 20, array['VIEW', 'CREATE', 'EDIT'], false, true);

-- The figures of the QC loading form of the old mobile application. The plausibility ranges (min_valid,
-- max_valid) only stop typing mistakes and are deliberately wide; they are assumptions of IT and still have to be
-- confirmed by QC. quality_values.value cannot be below zero, so no range starts below zero.
-- They start switched off: for now the plant records only FFA, moisture and impurities (owner's decision,
-- 21 November 2026). Switching one on (is_active) puts it on the QC loading form without a code change.
insert into quality_parameters (code, name, unit, decimals, min_valid, max_valid, sort_order, is_active) values
    ('MNI',           'M dan I',             '%',      3, 0, 5,   4, false),
    ('IV',            'IV',                  '',       2, 0, 200, 5, false),
    ('LOVIBOND',      'Lovibond Color',      '',       1, 0, 50,  6, false),
    ('MELTING_POINT', 'Melting Point',       '°C',     1, 0, 80,  7, false),
    ('CLOUD_POINT',   'Cloud Point',         '°C',     1, 0, 60,  8, false),
    ('SAPONIFIABLE',  'Saponifiable Matter', '%',      2, 0, 100, 9, false),
    ('PEROXIDE',      'Peroxide Value',      'meq/kg', 2, 0, 50,  10, false),
    ('SMOKE_POINT',   'Smoke Point',         '°C',     0, 0, 300, 11, false);

-- QC at receiving: the disposition the operator chose (OK, HOLD, NOT OK) and the out-spec reason of the old
-- form, required unless the disposition is OK. `decision` is what holds in the end: PASS or REJECT once someone
-- decided (the operator for OK, the QC supervisor after a hold), HOLD while the supervisor has not.
alter table quality_checks add column disposition text check (disposition in ('OK', 'HOLD', 'NOT_OK'));
alter table quality_checks add column reason_code text check (reason_code in ('FFA_OUT', 'MI_OUT', 'FFA_MI_OUT'));
-- nomor CoA, issued by QC loading
alter table quality_checks add column certificate_no text unique;
alter table quality_checks add constraint quality_checks_disposition_stage check (disposition is null or stage = 'RECEIVING');
alter table quality_checks add constraint quality_checks_reason check (disposition is null or (disposition = 'OK') = (reason_code is null));
alter table quality_checks add constraint quality_checks_reason_needs_disposition check (reason_code is null or disposition is not null);
alter table quality_checks add constraint quality_checks_certificate_stage check (certificate_no is null or stage = 'LOADING');
alter table quality_checks add constraint quality_checks_decided
    check (decision is null or decision = 'HOLD' or (decided_by is not null and decided_at is not null));

-- nomor surat jalan (issued when loading is finished) and nomor surat out spec (issued at the reseal of a
-- rejected incoming truck)
alter table trips add column delivery_note_no text unique;
alter table trips add column out_spec_letter_no text unique;

-- Patterns of the new numbers, next to do_number_format (migration 0003 lists the placeholders). Each series is
-- numbered per site per year.
insert into settings (site_id, key, value)
select s.id, v.key, v.value::jsonb
from sites s
cross join (values
    ('coa_number_format',             '"{seq:4}/COA/{site}/{roman}/{yyyy}"'),
    ('delivery_note_number_format',   '"{seq:4}/SJ/{site}/{roman}/{yyyy}"'),
    ('out_spec_letter_number_format', '"{seq:4}/OS/{site}/{roman}/{yyyy}"')
) as v (key, value)
on conflict do nothing;

-- The step that put a seal on, who took it off again (more or less load), and one truck per stock seal.
alter table trip_seals add column trip_step_id bigint references trip_steps (id);
alter table trip_seals add column removed_by bigint references users (id);
alter table trip_seals add constraint trip_seals_removed check ((removed_at is null) = (remove_reason is null));
create unique index trip_seals_seal_key on trip_seals (seal_id) where seal_id is not null;

-- Every form a phone sent, with the answer it got. A form sent again with the same client_uuid gets the stored
-- answer instead of being saved twice (the phone keeps a queue and resends when the signal returns).
create table field_submissions (
    client_uuid   uuid primary key,
    trip_step_id  bigint not null references trip_steps (id),
    form          text not null check (form in ('SEAL_CHECK', 'QC_RECEIVING', 'RESEAL', 'UNLOADING', 'CLEANLINESS', 'QC_LOADING',
                                                'LOADING_START', 'LOADING_FINISH', 'SEALING')),
    user_id       bigint not null references users (id),
    response      jsonb not null,
    created_at    timestamptz not null default now()
);
create index field_submissions_step_idx on field_submissions (trip_step_id);
