-- Timbangan Registrasi: initial database schema (PostgreSQL 16 or newer).
-- Migrations are plain SQL files applied in file-name order. A file that has been applied is never edited;
-- a schema change is a new numbered file.
--
-- Conventions
--   * Names are English, snake_case, plural. Indonesian business terms are given in comments.
--   * Weights are whole kilograms (integer). Contract quantities are numeric with a unit of measure.
--   * Every time column is timestamptz. Enumerations are text with a CHECK constraint.
--   * Plate numbers are stored without spaces in plate_no ("BK8790VB") and as printed in plate_display.
--   * Rows copied from the ERP carry (erp_system, erp_ref); nothing else in this schema knows which ERP it is.
--   * The ERP is read only (contracts, partners, products). Nothing in this schema is posted back to it.

-- ---------------------------------------------------------------------------------------------------------
-- A. Sites, users, access
-- ---------------------------------------------------------------------------------------------------------

create table sites (
    id          smallint generated always as identity primary key,
    code        text not null unique,                       -- branch code, "SMK"
    name        text not null,
    timezone    text not null default 'Asia/Jakarta',
    is_active   boolean not null default true
);

-- Business partners: supplier / PKS, customer, transporter. One row can hold several roles.
create table partners (
    id              bigint generated always as identity primary key,
    erp_system      text check (erp_system in ('ODOO', 'SAP')),
    erp_ref         text,                                   -- id of the partner in that ERP
    code            text,
    name            text not null,
    address         text,
    is_supplier     boolean not null default false,
    is_customer     boolean not null default false,
    is_transporter  boolean not null default false,
    is_active       boolean not null default true,
    synced_at       timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (erp_system, erp_ref),
    check ((erp_system is null) = (erp_ref is null))        -- transporters kept locally have neither
);
create index partners_name_idx on partners (lower(name));

create table users (
    id                    bigint generated always as identity primary key,
    kind                  text not null check (kind in ('INTERNAL', 'PARTNER')),
    partner_id            bigint references partners (id),  -- the company a portal account belongs to
    site_id               smallint references sites (id),   -- home site of an internal user
    username              text not null,
    full_name             text not null,
    email                 text,
    phone                 text,
    password_hash         text,                             -- partner accounts; null for staff, who sign in through the portal
    sso_subject           text unique,                      -- user id (uuid) in the company portal
    employee_no           text,                             -- NRK, as sent by the portal
    sso_profile           jsonb,                            -- job title, unit, grade as of the last sign-in
    must_change_password  boolean not null default false,
    is_active             boolean not null default true,
    last_login_at         timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    check ((kind = 'PARTNER') = (partner_id is not null)),
    check (password_hash is not null or sso_subject is not null)
);
create unique index users_username_key on users (lower(username));

create table roles (
    code    text primary key,
    name    text not null,
    scope   text not null check (scope in ('INTERNAL', 'PARTNER'))
);

create table user_roles (
    user_id     bigint not null references users (id) on delete cascade,
    role_code   text not null references roles (code),
    site_id     smallint references sites (id),             -- null = every site
    granted_by  bigint references users (id),
    granted_at  timestamptz not null default now()
);
create unique index user_roles_key on user_roles (user_id, role_code, coalesce(site_id, 0));

-- Refresh tokens. Only a hash is stored; a row is one signed-in browser or phone.
create table auth_sessions (
    id            bigint generated always as identity primary key,
    user_id       bigint not null references users (id) on delete cascade,
    token_hash    text not null unique,
    client        text not null check (client in ('WEB', 'ANDROID', 'IOS')),
    device_label  text,
    ip            inet,
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz,
    expires_at    timestamptz not null,
    revoked_at    timestamptz
);
create index auth_sessions_user_idx on auth_sessions (user_id) where revoked_at is null;

-- Push notification targets (FCM / APNs token of one installed app).
create table user_devices (
    id            bigint generated always as identity primary key,
    user_id       bigint not null references users (id) on delete cascade,
    platform      text not null check (platform in ('ANDROID', 'IOS', 'WEB')),
    push_token    text not null unique,
    app_version   text,
    is_active     boolean not null default true,
    last_seen_at  timestamptz not null default now()
);
create index user_devices_user_idx on user_devices (user_id) where is_active;

-- ---------------------------------------------------------------------------------------------------------
-- B. Master data
-- ---------------------------------------------------------------------------------------------------------

create table products (
    id          bigint generated always as identity primary key,
    erp_system  text check (erp_system in ('ODOO', 'SAP')),
    erp_ref     text,
    code        text,
    name        text not null,
    uom         text not null default 'kg',
    category    text not null check (category in ('CPO', 'BULK_LIQUID', 'PACKED', 'MATERIAL', 'OTHER')),
    is_active   boolean not null default true,
    synced_at   timestamptz,
    unique (erp_system, erp_ref),
    check ((erp_system is null) = (erp_ref is null))
);

create table vehicle_types (
    code                text primary key,                   -- TANGKI, ISO_TANK, KONTAINER, BOX, BAK
    name                text not null,
    is_tank             boolean not null default false,
    needs_container_no  boolean not null default false
);

create table vehicles (
    id                 bigint generated always as identity primary key,
    plate_no           text not null unique check (plate_no ~ '^[A-Z0-9]{3,12}$'),
    plate_display      text not null,
    vehicle_type_code  text not null references vehicle_types (code),
    owner_partner_id   bigint references partners (id),     -- pemilik: the transporter
    ownership          text check (ownership in ('SENDIRI', 'MITRA')),
    capacity_kg        integer check (capacity_kg > 0),      -- daya angkut
    production_year    smallint check (production_year between 1970 and 2100),
    tare_kg            integer check (tare_kg > 0),          -- tarra master, reference for the tare check
    stnk_valid_until   date,
    tax_valid_until    date,
    kir_valid_until    date,
    is_active          boolean not null default true,
    created_by         bigint references users (id),
    verified_by        bigint references users (id),        -- set when logistics confirms a vehicle a partner entered
    verified_at        timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);
create index vehicles_owner_idx on vehicles (owner_partner_id);

-- Every change of the master tare, by hand or taken from a weighing.
create table vehicle_tare_history (
    id           bigint generated always as identity primary key,
    vehicle_id   bigint not null references vehicles (id),
    tare_kg      integer not null check (tare_kg > 0),
    source       text not null check (source in ('MANUAL', 'WEIGHING', 'IMPORT')),
    weighing_id  bigint,                                    -- foreign key added after weighings exists
    reason       text,
    changed_by   bigint references users (id),
    changed_at   timestamptz not null default now()
);
create index vehicle_tare_history_vehicle_idx on vehicle_tare_history (vehicle_id, changed_at desc);

create table drivers (
    id                   bigint generated always as identity primary key,
    full_name            text not null,
    licence_no           text not null unique check (licence_no ~ '^[A-Z0-9]{6,20}$'),  -- nomor SIM, no spaces
    licence_class        text,
    licence_valid_until  date,
    phone                text,
    home_partner_id      bigint references partners (id),   -- transporter that registered the driver
    -- central driver registry (VCF): the status is copied on every sync and decides warning or refusal
    registry_ref         text unique,                       -- id of the driver in the registry
    registry_status      text not null default 'UNKNOWN' check (registry_status in ('UNKNOWN', 'NORMAL', 'WARNING', 'BLACKLIST')),
    registry_synced_at   timestamptz,
    registry_push        text not null default 'NONE' check (registry_push in ('NONE', 'PENDING', 'SENT', 'FAILED')),  -- a driver new here is sent to the registry
    registry_push_error  text,
    is_active            boolean not null default true,
    created_by           bigint references users (id),
    verified_by          bigint references users (id),
    verified_at          timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create index drivers_name_idx on drivers (lower(full_name));

-- A driver is blocked while a row exists with lifted_at null and blocked_until not yet passed.
create table driver_blocks (
    id             bigint generated always as identity primary key,
    driver_id      bigint not null references drivers (id),
    reason         text not null,
    source         text not null default 'LOCAL' check (source in ('LOCAL', 'CENTRAL')),
    blocked_by     bigint references users (id),
    blocked_at     timestamptz not null default now(),
    blocked_until  timestamptz,
    lifted_by      bigint references users (id),
    lifted_at      timestamptz,
    lift_reason    text
);
create index driver_blocks_active_idx on driver_blocks (driver_id) where lifted_at is null;

-- Quality parameters (spek): FFA, moisture, impurities today; more rows later without a schema change.
create table quality_parameters (
    code        text primary key,
    name        text not null,
    unit        text not null default '%',
    decimals    smallint not null default 2 check (decimals between 0 and 4),
    min_valid   numeric(9, 4) not null default 0,           -- plausibility range for data entry
    max_valid   numeric(9, 4) not null default 100,
    sort_order  smallint not null default 0,
    is_active   boolean not null default true
);

-- Acceptance limits per product. A value outside the limits makes the QC step HOLD or REJECT.
create table product_quality_specs (
    id              bigint generated always as identity primary key,
    product_id      bigint not null references products (id),
    parameter_code  text not null references quality_parameters (code),
    min_value       numeric(9, 4),
    max_value       numeric(9, 4),
    on_fail         text not null default 'HOLD' check (on_fail in ('INFO', 'HOLD', 'REJECT')),
    valid_from      date not null default current_date,
    unique (product_id, parameter_code, valid_from)
);

create table storage_tanks (
    id          integer generated always as identity primary key,
    site_id     smallint not null references sites (id),
    code        text not null,                              -- TK101
    name        text,
    product_id  bigint references products (id),
    capacity_kg bigint,
    erp_ref     text,                                       -- stock location in the ERP
    is_active   boolean not null default true,
    unique (site_id, code)
);

-- Stock of seal numbers (segel / locis, and customs seals) handed to the seal officer.
create table seals (
    id         bigint generated always as identity primary key,
    site_id    smallint not null references sites (id),
    seal_no    text not null,
    kind       text not null default 'LOCIS' check (kind in ('LOCIS', 'CUSTOMS')),
    status     text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'USED', 'VOID')),
    batch_ref  text,
    created_at timestamptz not null default now(),
    unique (site_id, kind, seal_no)
);

-- ---------------------------------------------------------------------------------------------------------
-- C. Plant map, stations, flows, rules
-- ---------------------------------------------------------------------------------------------------------

-- An area of the plant drawn on the dashboard map.
create table zones (
    id          integer generated always as identity primary key,
    site_id     smallint not null references sites (id),
    code        text not null,
    name        text not null,
    kind        text not null check (kind in ('GATE', 'REGISTRATION', 'QUEUE_PARKING', 'WEIGHBRIDGE', 'QC', 'STAGING',
                                              'UNLOADING', 'LOADING', 'DOCK', 'SEALING', 'EXIT')),
    color       text check (color ~ '^#[0-9a-f]{6}$'),      -- colour of the zone on the layout drawing
    map_shape   jsonb,                                      -- polygon on the plan, in fractions of its width and height
    capacity    smallint,
    sort_order  smallint not null default 0,
    unique (site_id, code)
);

-- A physical point where something happens to a truck: registration desk, weighbridge, bay.
create table stations (
    id            integer generated always as identity primary key,
    site_id       smallint not null references sites (id),
    code          text not null,
    name          text not null,
    kind          text not null check (kind in ('REGISTRATION', 'GATE', 'WEIGHBRIDGE', 'QC', 'STAGING', 'UNLOADING_BAY',
                                                'LOADING_BAY', 'DOCK', 'SEALING')),
    zone_id       integer references zones (id),
    config        jsonb not null default '{}',              -- for a weighbridge: plate-reader camera per weighing stage
    api_key_hash  text,                                     -- machine credential of the PC at this station
    is_active     boolean not null default true,
    unique (site_id, code)
);

-- The ordered steps of each flow. Seed data, kept in a table because the dashboard and the mobile work
-- lists are both derived from it and sites can differ.
create table flow_steps (
    site_id         smallint not null references sites (id),
    flow_code       text not null check (flow_code in ('IN_CPO', 'IN_GOODS', 'OUT_BULK', 'OUT_PACKED')),
    step_code       text not null check (step_code in ('CHECK_IN', 'SEAL_CHECK', 'WEIGH_1', 'QC', 'UNLOADING',
                                                       'TANK_CHECK', 'RESEAL', 'CLEANLINESS', 'QC_LOADING',
                                                       'LOADING', 'SEALING', 'WEIGH_2', 'CHECK_OUT')),
    seq             smallint not null,
    name            text not null,
    is_optional     boolean not null default false,         -- RESEAL exists only after a rejection
    on_reject       text not null default 'SKIP' check (on_reject in ('RUN', 'SKIP')),  -- after a rejection: still done, or skipped
    performer_role  text references roles (code),
    wait_zone_id    integer references zones (id),          -- where a truck is shown while the step is READY
    work_zone_id    integer references zones (id),          -- where it is shown while the step is IN_PROGRESS
    primary key (site_id, flow_code, step_code),
    unique (site_id, flow_code, seq)
);

-- What counts as an exception and who decides it.
create table exception_rules (
    id                integer generated always as identity primary key,
    site_id           smallint not null references sites (id),
    type              text not null check (type in ('PLATE', 'GROSS_IN', 'TARE_OUT', 'NET_IN', 'NET_OUT', 'QC_HOLD')),
    flow_code         text,                                 -- null = every flow
    threshold_pct     numeric(7, 4),                        -- GROSS_IN uses the contract tolerance when this is null
    threshold_kg      integer,
    on_exceed         text not null default 'APPROVAL' check (on_exceed in ('WARN', 'APPROVAL', 'BLOCK')),
    approver_role     text not null references roles (code),
    escalate_after_s  integer check (escalate_after_s > 0),
    escalate_role     text references roles (code),
    is_active         boolean not null default true,
    valid_from        date not null default current_date
);
create unique index exception_rules_key on exception_rules (site_id, type, coalesce(flow_code, ''), valid_from);

create table settings (
    site_id     smallint references sites (id),             -- null = global
    key         text not null,
    value       jsonb not null,
    updated_by  bigint references users (id),
    updated_at  timestamptz not null default now()
);
create unique index settings_key on settings (coalesce(site_id, 0), key);

-- Gapless numbering of printed documents. One row per series, locked while the next number is taken.
create table document_counters (
    counter_key  text primary key,                          -- "SPJ/SMK/2026/11", "BA-SELISIH-TARRA/SMK/2026"
    last_no      integer not null default 0
);

-- ---------------------------------------------------------------------------------------------------------
-- D. Contracts copied from the ERP, and delivery orders issued here
-- ---------------------------------------------------------------------------------------------------------

-- One product line of a purchase contract (incoming) or of a sales contract (outgoing), copied by the ERP
-- adapter and read-only for the rest of the application. In Odoo 13: purchase.requisition.line and
-- sale.blanket.order.line. Nearly every contract has one line, so contract_no is repeated, not unique.
create table erp_contracts (
    id             bigint generated always as identity primary key,
    erp_system     text not null check (erp_system in ('ODOO', 'SAP')),
    erp_ref        text not null,                           -- model and id of the line in the ERP
    site_id        smallint references sites (id),
    direction      text not null check (direction in ('IN', 'OUT')),
    contract_no    text not null,
    partner_id     bigint not null references partners (id),
    product_id     bigint not null references products (id),
    qty_contract   numeric(16, 3),
    qty_done_erp   numeric(16, 3),                          -- received or delivered according to the ERP, shown for comparison only
    qty_opening    numeric(16, 3) not null default 0,       -- realised before this application took over; set once at cut-over
    customer_po_no text,                                    -- PO customer on a sales contract
    contract_date  date,
    uom            text not null default 'kg',
    tolerance_pct  numeric(7, 4) not null default 0,        -- > 0: settled on the sent figure; 0: on the received figure
    certificate    text,                                    -- RSPO / ISCC / MB when the contract carries one
    valid_from     date,
    valid_until    date,
    state          text not null check (state in ('OPEN', 'CLOSED', 'CANCELLED')),
    raw            jsonb,                                   -- the ERP record as received, for tracing
    synced_at      timestamptz not null default now(),
    unique (erp_system, erp_ref)
);
create index erp_contracts_no_idx on erp_contracts (upper(contract_no) text_pattern_ops);
create index erp_contracts_partner_idx on erp_contracts (partner_id, direction) where state = 'OPEN';

-- Where goods are delivered. Kept here because the ERP partner carries only street, city and province.
create table destinations (
    id          bigint generated always as identity primary key,
    partner_id  bigint references partners (id),            -- customer; null = usable for any customer
    name        text not null,                              -- nama tempat
    address     text not null,
    district    text,                                       -- kecamatan
    regency     text,                                       -- kabupaten / kota
    province    text,
    is_active   boolean not null default true,
    created_by  bigint references users (id),
    created_at  timestamptz not null default now()
);
create index destinations_partner_idx on destinations (partner_id) where is_active;

-- Delivery order (DO) written by the logistics admin and sent to one transporter (outgoing). The transporter
-- answers with a list of trucks: that list is a registration, each truck a trip.
create table delivery_orders (
    id               bigint generated always as identity primary key,
    site_id          smallint not null references sites (id),
    do_no            text not null unique,
    do_date          date not null,
    contract_id      bigint references erp_contracts (id),   -- null: transfer, waste or scrap without a sales contract
    contract_no      text,                                    -- copied when written, so history survives the ERP
    customer_po_no   text,
    partner_id       bigint not null references partners (id),   -- customer or receiver
    product_id       bigint not null references products (id),   -- taken from the contract
    qty              numeric(16, 3) not null check (qty > 0),
    uom              text not null default 'kg',
    tolerance_pct    numeric(7, 4) not null default 0,
    destination_id   bigint not null references destinations (id),
    delivery_from    date not null,                           -- tanggal delivery
    delivery_until   date,
    transport_terms  text,                                    -- LOCO / EXWORK / FRANCO as printed on the DO
    transporter_id   bigint references partners (id),         -- empty while the DO is a draft
    truck_count      smallint check (truck_count between 1 and 500),
    truck_count_by   text check (truck_count_by in ('ADMIN', 'TRANSPORTER')),
    status           text not null default 'DRAFT' check (status in ('DRAFT', 'SENT', 'ACCEPTED', 'CLOSED', 'CANCELLED')),
    remark           text,
    created_by       bigint not null references users (id),
    sent_at          timestamptz,
    accepted_by      bigint references users (id),            -- transporter account that opened and accepted it
    accepted_at      timestamptz,
    closed_at        timestamptz,
    cancel_reason    text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    check (delivery_until is null or delivery_until >= delivery_from),
    check (status in ('DRAFT', 'CANCELLED') or transporter_id is not null),
    check ((truck_count is null) = (truck_count_by is null))
);
create index delivery_orders_transporter_idx on delivery_orders (transporter_id, status);
create index delivery_orders_contract_idx on delivery_orders (contract_id);

create table erp_sync_runs (
    id             bigint generated always as identity primary key,
    erp_system     text not null check (erp_system in ('ODOO', 'SAP', 'VCF')),
    entity         text not null check (entity in ('PARTNER', 'PRODUCT', 'CONTRACT', 'DRIVER')),  -- DRIVER: the central driver registry
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    status         text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'FAILED')),
    cursor_value   text,                                    -- last change marker read from the ERP
    rows_upserted  integer not null default 0,
    error          text
);

-- ---------------------------------------------------------------------------------------------------------
-- E. Registration, trips, SPJ, RFID card
-- ---------------------------------------------------------------------------------------------------------

create table files (
    id             bigint generated always as identity primary key,
    storage_key    text not null unique,                    -- path below the storage root, never a user-supplied name
    original_name  text,
    mime_type      text not null,
    size_bytes     bigint not null check (size_bytes >= 0),
    sha256         text not null,
    kind           text not null check (kind in ('PHOTO', 'SCAN', 'PDF', 'OTHER')),
    captured_at    timestamptz,
    uploaded_by    bigint references users (id),
    created_at     timestamptz not null default now()
);

-- One request from a partner or an operator. Incoming: which contracts and how many trucks. Outgoing: the
-- transporter's list of trucks for one or more delivery orders.
create table registrations (
    id              bigint generated always as identity primary key,
    site_id         smallint not null references sites (id),
    reg_no          text not null unique,
    direction       text not null check (direction in ('IN', 'OUT')),
    flow_code       text not null check (flow_code in ('IN_CPO', 'IN_GOODS', 'OUT_BULK', 'OUT_PACKED')),
    partner_id      bigint not null references partners (id),      -- supplier or customer of the first contract; the product
                                                                   -- and partner of each row come from its contract or DO
    transporter_id  bigint references partners (id),
    status          text not null default 'DRAFT'
                    check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED')),
    planned_date    date,                                    -- expected arrival
    truck_count     smallint not null default 1 check (truck_count between 1 and 200),
    qty_total       numeric(16, 3) check (qty_total > 0),
    uom             text not null default 'kg',
    close_cargo     boolean,
    flexi_bag       boolean,
    remark          text,
    created_via     text not null check (created_via in ('PORTAL', 'OPERATOR', 'SCAN', 'API')),
    created_by      bigint not null references users (id),
    submitted_at    timestamptz,
    reviewed_by     bigint references users (id),
    reviewed_at     timestamptz,
    review_note     text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    check ((direction = 'IN') = (flow_code in ('IN_CPO', 'IN_GOODS'))),
    -- an outgoing request cannot be submitted before close cargo and flexi bag are answered
    check (direction = 'IN' or status in ('DRAFT', 'CANCELLED') or (close_cargo is not null and flexi_bag is not null))
);
create index registrations_partner_idx on registrations (partner_id, created_at desc);
create index registrations_transporter_idx on registrations (transporter_id, created_at desc);
create index registrations_status_idx on registrations (site_id, status, planned_date);

-- The contracts of a registration. Several rows = multi kontrak, on one registration.
create table registration_allocations (
    id               bigint generated always as identity primary key,
    registration_id  bigint not null references registrations (id) on delete cascade,
    seq              smallint not null check (seq >= 1),
    contract_id        bigint references erp_contracts (id),     -- incoming: the purchase contract
    delivery_order_id  bigint references delivery_orders (id),   -- outgoing: the DO, which carries its contract
    qty_planned      numeric(16, 3) check (qty_planned > 0),
    contract_no      text not null,                          -- copied when registered, so history survives the ERP
    do_no            text,
    tolerance_pct    numeric(7, 4) not null default 0,
    unique (registration_id, seq),
    unique (registration_id, contract_id),
    unique (registration_id, delivery_order_id),
    check (num_nonnulls(contract_id, delivery_order_id) = 1)
);
create index registration_allocations_contract_idx on registration_allocations (contract_id);
create index registration_allocations_do_idx on registration_allocations (delivery_order_id);

-- One visit of one truck. The card, the weighings and every field step hang on this row.
create table trips (
    id               bigint generated always as identity primary key,
    site_id          smallint not null references sites (id),
    registration_id  bigint not null references registrations (id),
    seq              smallint not null default 1 check (seq >= 1),
    trip_no          text unique,                            -- queue / ticket number, given at check-in
    status           text not null default 'DRAFT'
                     check (status in ('DRAFT', 'READY', 'ISSUED', 'CHECKED_IN', 'IN_PROCESS', 'COMPLETED',
                                       'REJECTED', 'CANCELLED', 'EXPIRED')),
    outcome          text check (outcome in ('OK', 'TRUCK_REJECT', 'SPEC_REJECT', 'SEAL_REJECT', 'OTHER_REJECT')),
    vehicle_id       bigint references vehicles (id),
    driver_id        bigint references drivers (id),
    transporter_id   bigint references partners (id),
    container_no     text,
    plate_no         text,                                   -- copies frozen when the SPJ is issued
    driver_name      text,
    licence_no       text,
    qty_planned      numeric(16, 3) check (qty_planned > 0),
    planned_arrival  date,
    doc_gross_kg     integer check (doc_gross_kg > 0),       -- from the supplier's letters ("bruto from")
    doc_tare_kg      integer check (doc_tare_kg > 0),
    doc_net_kg       integer check (doc_net_kg > 0),
    gross_kg         integer check (gross_kg > 0),           -- from the valid weighings
    tare_kg          integer check (tare_kg > 0),
    net_kg           integer,
    current_step     text,
    checked_in_at    timestamptz,
    completed_at     timestamptz,
    exited_at        timestamptz,
    cancelled_at     timestamptz,
    cancel_reason    text,
    remark           text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (registration_id, seq),
    check (net_kg is null or (gross_kg is not null and tare_kg is not null and net_kg = gross_kg - tare_kg)),
    -- a trip can be issued only with a vehicle and a driver
    check (status in ('DRAFT', 'CANCELLED', 'EXPIRED') or (vehicle_id is not null and driver_id is not null)),
    -- the outcome is written when it is known (for example at a QC rejection); the status stays IN_PROCESS
    -- until the truck has checked out and returned its card, and only then becomes COMPLETED or REJECTED
    check (status not in ('COMPLETED', 'REJECTED') or outcome is not null),
    check (status <> 'COMPLETED' or outcome = 'OK'),
    check (status <> 'REJECTED' or outcome <> 'OK')
);
-- A vehicle and a driver are inside the plant at most once at a time.
create unique index trips_vehicle_inside_key on trips (vehicle_id) where status in ('CHECKED_IN', 'IN_PROCESS');
create unique index trips_driver_inside_key on trips (driver_id) where status in ('CHECKED_IN', 'IN_PROCESS');
create index trips_board_idx on trips (site_id, status, current_step);
create index trips_arrival_idx on trips (site_id, planned_arrival) where status in ('READY', 'ISSUED');
create index trips_plate_idx on trips (plate_no);

-- The share of one contract in one truck. Incoming: one row per supplier letter.
create table trip_allocations (
    id                          bigint generated always as identity primary key,
    trip_id                     bigint not null references trips (id) on delete cascade,
    registration_allocation_id  bigint not null references registration_allocations (id),
    seq                         smallint not null check (seq >= 1),
    qty_planned                 numeric(16, 3) check (qty_planned > 0),
    handover_no                 text,                        -- nomor penyerahan, incoming and outgoing
    -- the supplier's letter for this contract (incoming)
    spb_no                      text,                        -- nomor surat pengantar
    spb_date                    date,
    origin_ticket_no            text,                        -- weighbridge ticket of the sender
    origin_gross_kg             integer check (origin_gross_kg > 0),
    origin_tare_kg              integer check (origin_tare_kg > 0),
    origin_net_kg               integer check (origin_net_kg > 0),
    -- result
    net_kg                      integer check (net_kg >= 0), -- this contract's share of the weighed net
    qty_actual                  numeric(16, 3) check (qty_actual >= 0),  -- realised quantity in the unit of the contract or DO:
                                                             -- equal to net_kg for kilograms, the counted boxes for packed goods
    split_method                text check (split_method in ('SINGLE', 'PROPORTIONAL', 'SEQUENTIAL', 'MANUAL')),
    split_by                    bigint references users (id),
    split_at                    timestamptz,
    unique (trip_id, seq),
    unique (trip_id, registration_allocation_id),
    check ((net_kg is null) = (split_method is null))
);
create index trip_allocations_regalloc_idx on trip_allocations (registration_allocation_id);

-- Surat jalan with barcode, one per trip. Re-issuing revokes the old one and makes a new token.
create table spj_documents (
    id             bigint generated always as identity primary key,
    trip_id        bigint not null references trips (id),
    spj_no         text not null unique,
    barcode_token  text not null unique check (barcode_token ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),  -- random, no meaning
    issued_by      bigint not null references users (id),
    issued_at      timestamptz not null default now(),
    valid_until    timestamptz,
    print_count    integer not null default 0,
    file_id        bigint references files (id),
    revoked_at     timestamptz,
    revoked_by     bigint references users (id),
    revoke_reason  text
);
create unique index spj_documents_active_key on spj_documents (trip_id) where revoked_at is null;

create table rfid_cards (
    id       bigint generated always as identity primary key,
    site_id  smallint not null references sites (id),
    uid      text not null unique check (uid ~ '^[0-9A-F]{8,20}$'),   -- as hexadecimal, normalised by the API
    label    text,                                           -- number printed on the card
    status   text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'IN_USE', 'LOST', 'RETIRED')),
    note     text
);

-- Which card a truck carries. A card serves one trip at a time and is reused afterwards.
create table card_assignments (
    id              bigint generated always as identity primary key,
    card_id         bigint not null references rfid_cards (id),
    trip_id         bigint not null references trips (id),
    station_id      integer references stations (id),
    assigned_by     bigint not null references users (id),
    assigned_at     timestamptz not null default now(),
    released_by     bigint references users (id),
    released_at     timestamptz,
    release_reason  text check (release_reason in ('CHECK_OUT', 'REPLACED', 'CANCELLED', 'LOST'))
);
create unique index card_assignments_card_key on card_assignments (card_id) where released_at is null;
create unique index card_assignments_trip_key on card_assignments (trip_id) where released_at is null;

-- ---------------------------------------------------------------------------------------------------------
-- F. What happens inside the plant
-- ---------------------------------------------------------------------------------------------------------

-- The steps of one trip, copied from flow_steps at check-in. The dashboard counts these rows.
create table trip_steps (
    id            bigint generated always as identity primary key,
    trip_id       bigint not null references trips (id) on delete cascade,
    step_code     text not null,
    seq           smallint not null,
    attempt       smallint not null default 1 check (attempt >= 1),   -- a repeated weighing is a new attempt
    status        text not null default 'PENDING'
                  check (status in ('PENDING', 'READY', 'IN_PROGRESS', 'DONE', 'SKIPPED', 'FAILED')),
    result        text check (result in ('PASS', 'FAIL', 'HOLD')),
    station_id    integer references stations (id),
    performed_by  bigint references users (id),
    ready_at      timestamptz,
    started_at    timestamptz,
    finished_at   timestamptz,
    note          text,
    unique (trip_id, step_code, attempt)
);
create index trip_steps_worklist_idx on trip_steps (step_code, status) where status in ('READY', 'IN_PROGRESS');

create table weighings (
    id                bigint generated always as identity primary key,
    trip_id           bigint not null references trips (id),
    trip_step_id      bigint references trip_steps (id),
    station_id        integer not null references stations (id),
    stage             smallint not null check (stage in (1, 2)),
    kind              text not null check (kind in ('GROSS', 'TARE')),
    weight_kg         integer not null check (weight_kg > 0),
    raw_reading       text,                                  -- what the indicator sent, unedited
    weighed_at        timestamptz not null default now(),
    mode              text not null default 'AUTO' check (mode in ('AUTO', 'EXCEPTION')),
    card_uid          text,
    plate_read        text,                                  -- what the camera read
    plate_confidence  numeric(5, 4),
    plate_check       text not null check (plate_check in ('MATCH', 'CONFIRMED', 'BYPASSED')),
    status            text not null default 'VALID' check (status in ('PENDING', 'VALID', 'VOID')),
    void_reason       text,
    voided_by         bigint references users (id),
    voided_at         timestamptz,
    created_at        timestamptz not null default now(),
    check ((status = 'VOID') = (voided_at is not null))
);
-- A trip has one valid first weighing and one valid second weighing; replaced readings stay as VOID rows.
create unique index weighings_valid_key on weighings (trip_id, stage) where status = 'VALID';
create index weighings_trip_idx on weighings (trip_id);

alter table vehicle_tare_history
    add constraint vehicle_tare_history_weighing_fk foreign key (weighing_id) references weighings (id);

-- One sampling and decision by QC. The method column is where the dip probe and the sampling machine fit later.
create table quality_checks (
    id            bigint generated always as identity primary key,
    trip_id       bigint not null references trips (id),
    trip_step_id  bigint references trip_steps (id),
    stage         text not null check (stage in ('RECEIVING', 'LOADING')),
    method        text not null default 'MANUAL' check (method in ('MANUAL', 'DIP_PROBE', 'AUTO_SAMPLER', 'LAB')),
    device_ref    text,
    tank_id       integer references storage_tanks (id),
    sampled_by    bigint references users (id),
    sampled_at    timestamptz not null default now(),
    decision      text check (decision in ('PASS', 'HOLD', 'REJECT')),
    decided_by    bigint references users (id),
    decided_at    timestamptz,
    remark        text,
    client_uuid   uuid unique                                -- set by the phone, makes a resend harmless
);
create index quality_checks_trip_idx on quality_checks (trip_id);

-- A quality figure: declared on the supplier's letter, or measured here.
create table quality_values (
    id                  bigint generated always as identity primary key,
    parameter_code      text not null references quality_parameters (code),
    value               numeric(9, 4) not null check (value >= 0),
    source              text not null check (source in ('DECLARED', 'QC', 'LAB')),
    trip_allocation_id  bigint references trip_allocations (id) on delete cascade,
    quality_check_id    bigint references quality_checks (id) on delete cascade,
    check ((source = 'DECLARED') = (trip_allocation_id is not null)),
    check ((source <> 'DECLARED') = (quality_check_id is not null))
);
create unique index quality_values_declared_key on quality_values (trip_allocation_id, parameter_code)
    where trip_allocation_id is not null;
create unique index quality_values_measured_key on quality_values (quality_check_id, parameter_code)
    where quality_check_id is not null;

-- Checklist-type steps: seal check on arrival, tank empty check, cleanliness before loading.
create table inspections (
    id            bigint generated always as identity primary key,
    trip_id       bigint not null references trips (id),
    trip_step_id  bigint references trip_steps (id),
    kind          text not null check (kind in ('SEAL_CHECK', 'TANK_EMPTY', 'CLEANLINESS', 'TRUCK_CONDITION')),
    result        text not null check (result in ('PASS', 'FAIL')),
    checklist     jsonb not null default '[]',               -- [{ "item": "...", "ok": true, "note": "..." }]
    performed_by  bigint not null references users (id),
    performed_at  timestamptz not null default now(),
    remark        text,
    client_uuid   uuid unique
);
create index inspections_trip_idx on inspections (trip_id);

-- Unloading or loading log sheet. A blended load has one row per tank.
create table handlings (
    id             bigint generated always as identity primary key,
    trip_id        bigint not null references trips (id),
    trip_step_id   bigint references trip_steps (id),
    kind           text not null check (kind in ('UNLOAD', 'LOAD')),
    tank_id        integer references storage_tanks (id),
    station_id     integer references stations (id),
    started_at     timestamptz,
    finished_at    timestamptz,
    temperature_c  numeric(5, 1),
    qty_meter      numeric(16, 3),                           -- flow meter figure, for control only
    operator_id    bigint not null references users (id),
    log_sheet      jsonb not null default '{}',
    remark         text,
    client_uuid    uuid unique,
    check (finished_at is null or started_at is null or finished_at >= started_at)
);
create index handlings_trip_idx on handlings (trip_id);

create table trip_seals (
    id             bigint generated always as identity primary key,
    trip_id        bigint not null references trips (id),
    seal_no        text not null,
    kind           text not null default 'LOCIS' check (kind in ('LOCIS', 'CUSTOMS')),
    origin         text not null check (origin in ('DECLARED', 'APPLIED')),   -- on the supplier's letter, or put on here
    position       text,                                     -- manhole, bottom valve, box door
    seal_id        bigint references seals (id),
    photo_file_id  bigint references files (id),
    applied_by     bigint references users (id),
    applied_at     timestamptz,
    removed_at     timestamptz,                              -- a seal opened to adjust the load, then replaced
    remove_reason  text,
    unique (trip_id, kind, seal_no)
);

create table trip_files (
    trip_id      bigint not null references trips (id) on delete cascade,
    file_id      bigint not null references files (id),
    weighing_id  bigint references weighings (id),           -- camera pictures taken at one weighing
    step_code    text,
    label      text,                                         -- "weigh1_top", "letter_scan", "seal_manhole"
    primary key (trip_id, file_id)
);

-- ---------------------------------------------------------------------------------------------------------
-- G. Exceptions, approvals, notifications
-- ---------------------------------------------------------------------------------------------------------

-- A case the system will not decide alone. A supervisor decides it on the phone.
create table exceptions (
    id                bigint generated always as identity primary key,
    site_id           smallint not null references sites (id),
    trip_id           bigint not null references trips (id),
    trip_step_id      bigint references trip_steps (id),
    weighing_id       bigint references weighings (id),
    quality_check_id  bigint references quality_checks (id),
    type              text not null check (type in ('PLATE', 'GROSS_IN', 'TARE_OUT', 'NET_IN', 'NET_OUT', 'QC_HOLD')),
    status            text not null default 'PENDING'
                      check (status in ('PENDING', 'APPROVED', 'REJECTED', 'RETRY', 'CANCELLED', 'EXPIRED')),
    decision_code     text check (decision_code in ('OK', 'ADD_LOAD', 'REDUCE_LOAD')),   -- NET_OUT only
    expected_value    numeric(16, 3),
    actual_value      numeric(16, 3),
    diff_value        numeric(16, 3),
    diff_pct          numeric(9, 4),
    tolerance_pct     numeric(7, 4),
    live_weight_kg    integer,                               -- last figure sent by the weighbridge while the truck waits
    live_weight_at    timestamptz,
    context           jsonb not null default '{}',           -- plate texts, camera, figures shown to the approver
    approver_role     text not null references roles (code),
    raised_at         timestamptz not null default now(),
    reminder_count    smallint not null default 0,
    last_reminded_at  timestamptz,
    escalated_role    text references roles (code),          -- a second role that may decide once the time limit passed
    escalated_at      timestamptz,
    decided_by        bigint references users (id),
    decided_at        timestamptz,
    decision_reason   text,
    report_no         text unique,                           -- nomor Berita Acara
    report_file_id    bigint references files (id),
    check ((status in ('APPROVED', 'REJECTED', 'RETRY')) = (decided_by is not null and decided_at is not null)),
    check (decision_code is null or type = 'NET_OUT'),
    check (status <> 'RETRY' or decision_code in ('ADD_LOAD', 'REDUCE_LOAD')),
    -- a weight difference is never approved or rejected without a written reason
    check (status not in ('APPROVED', 'REJECTED') or type not in ('GROSS_IN', 'TARE_OUT', 'NET_IN')
           or coalesce(length(btrim(decision_reason)), 0) >= 3)   -- coalesce: a CHECK passes on NULL
);
-- One open request per trip and type; asking again returns the open one.
create unique index exceptions_pending_key on exceptions (trip_id, type) where status = 'PENDING';
create index exceptions_inbox_idx on exceptions (site_id, approver_role, raised_at) where status = 'PENDING';
create index exceptions_trip_idx on exceptions (trip_id);

create table notifications (
    id            bigint generated always as identity primary key,
    site_id       smallint references sites (id),
    type          text not null,                             -- "EXCEPTION_RAISED", "EXCEPTION_DECIDED", "TRIP_ARRIVED"
    severity      text not null default 'INFO' check (severity in ('INFO', 'WARNING', 'ALARM')),
    title         text not null,
    body          text not null,
    data          jsonb not null default '{}',
    exception_id  bigint references exceptions (id),
    trip_id       bigint references trips (id),
    created_at    timestamptz not null default now()
);

create table notification_deliveries (
    id               bigint generated always as identity primary key,
    notification_id  bigint not null references notifications (id) on delete cascade,
    user_id          bigint not null references users (id),
    device_id        bigint references user_devices (id),
    channel          text not null check (channel in ('PUSH', 'IN_APP')),
    sent_at          timestamptz,
    provider_ref     text,
    error            text,
    read_at          timestamptz
);
create index notification_deliveries_inbox_idx on notification_deliveries (user_id, read_at);

-- ---------------------------------------------------------------------------------------------------------
-- H. Audit
-- ---------------------------------------------------------------------------------------------------------

-- Append-only. Who changed what, with the values before and after.
create table audit_log (
    id           bigint generated always as identity primary key,
    at           timestamptz not null default now(),
    user_id      bigint references users (id),
    station_id   integer references stations (id),
    action       text not null,
    entity_type  text not null,
    entity_id    bigint,
    before       jsonb,
    after        jsonb,
    reason       text,
    ip           inet
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id, at desc);
create index audit_log_user_idx on audit_log (user_id, at desc);
