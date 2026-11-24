-- The archive of the old weighbridge application: one row per old registration (legacy_trips) and one per
-- approval request or deviation report (legacy_exceptions), copied by `npm run legacy:import`. Nothing in the
-- working tables refers to them and no route changes them; the history pages only read them.
--
-- The old database keeps weights and dates as text. Columns that are searched or summed are typed here: weights
-- as whole kilograms, times as timestamptz read in the plant's time zone. A value that could not be read is null,
-- and its original text is kept under details.original. Everything else of the old rows is kept in details.

create table legacy_trips (
    id              bigint generated always as identity primary key,
    site            text not null,                          -- signature of the old row: SMK, SBY; UNKNOWN when empty
    legacy_id       bigint not null,                        -- registrasi.id
    ticket_no       text,
    direction       text not null check (direction in ('IN', 'OUT', 'UNKNOWN')),
    material        text check (material in ('CPO', 'IN_GOODS', 'OUT_BULK', 'OUT_PACKED')),
    state           text not null check (state in ('COMPLETED', 'REJECTED_QC', 'REJECTED_CLEANLINESS', 'UNFINISHED')),
    entry_date      date,                                   -- tgl_entry
    arrived_at      timestamptz,                            -- tgl_masuk_truk
    left_at         timestamptz,                            -- tgl_keluar_truk
    plate_text      text,                                   -- as typed
    plate_no        text,                                   -- upper-case letters and digits of plate_text
    driver_name     text,
    licence_no      text,
    transporter     text,
    partner_name    text,
    mill            text,                                   -- asal PKS
    product_name    text,
    uom             text,
    reference       text,                                   -- origin: contract number (incoming) or DO number (outgoing)
    do_no           text,
    po_no           text,
    spb_no          text,
    handover_no     text,                                   -- nomor penyerahan
    doc_gross_kg    integer,                                -- angka surat
    doc_tare_kg     integer,
    doc_net_kg      integer,
    gross_kg        integer,                                -- weighbridge; of the whole truck in a multi-contract group
    tare_kg         integer,
    net_kg          integer,                                -- the share of this row in a multi-contract group
    weigh1_at       timestamptz,
    weigh2_at       timestamptz,
    weigh1_by       text,
    weigh2_by       text,
    group_id        bigint,                                 -- legacy id of the parent of a multi-contract group
    close_cargo     boolean,
    flexi_bag       boolean,
    details         jsonb not null default '{}',
    imported_at     timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (site, legacy_id)
);
create index legacy_trips_plate_idx on legacy_trips (plate_no);
create index legacy_trips_entry_idx on legacy_trips (entry_date);
create index legacy_trips_reference_idx on legacy_trips (upper(reference) text_pattern_ops);
create index legacy_trips_ticket_idx on legacy_trips (ticket_no);
create index legacy_trips_group_idx on legacy_trips (group_id) where group_id is not null;

-- selisih_approval rows (source APPROVAL) with the BA they led to, and BA rows no approval points to (REPORT).
create table legacy_exceptions (
    id                bigint generated always as identity primary key,
    site              text not null,
    source            text not null check (source in ('APPROVAL', 'REPORT')),
    legacy_id         bigint not null,                      -- selisih_approval.id or selisih.id
    legacy_reg_id     bigint,                               -- legacy_trips.legacy_id of the truck
    type              text,                                 -- tipe: BRUTO_IN, NETTO_IN, NETTO_OUT, PLAT, TARRA_OUT
    status            text,
    decision          text,                                 -- keputusan
    ticket_no         text,
    plate_text        text,
    driver_name       text,
    transporter       text,
    reference         text,
    doc_gross_kg      integer,                              -- bruto_from
    weighed_gross_kg  integer,                              -- bruto_wb
    weighed_tare_kg   integer,
    weighed_net_kg    integer,
    diff_kg           integer,                              -- selisih
    diff_pct          numeric,
    tolerance_pct     numeric,
    requested_at      timestamptz,
    responded_at      timestamptz,
    responded_by      text,
    report_no         text,                                 -- nomor BA
    report_at         timestamptz,
    report_by         text,
    details           jsonb not null default '{}',
    imported_at       timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (site, source, legacy_id)
);
create index legacy_exceptions_reg_idx on legacy_exceptions (legacy_reg_id);

-- One row per run of `npm run legacy:import` that writes (a dry run records nothing). progress holds the last
-- legacy id each part committed, so `--resume` can continue a run that stopped.
create table legacy_import_runs (
    id           bigint generated always as identity primary key,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    status       text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'FAILED')),
    options      jsonb not null default '{}',
    progress     jsonb not null default '{}',
    counts       jsonb not null default '{}',
    error        text
);
