-- Phase 8: positions of vehicles outside the plant (docs/fase-8-gps.md). GPS is optional per vehicle. Positions come
-- from two sources: a tracker device (through its provider's server or the device itself, signed with a key made
-- here) and the driver's phone, opened from a link printed on the SPJ. Inside the plant the steps of the trip still
-- say where a truck is.

insert into modules (code, name, sort_order, levels, partner_allowed, is_active) values
    ('gps', 'Lacak kendaraan', 21, array['VIEW', 'EDIT'], true, true);

-- Who may send positions: a provider integration (many devices behind one key) or a single device. The key is
-- shown once; only its SHA-256 is kept.
create table gps_sources (
    id              bigint generated always as identity primary key,
    name            text not null,
    kind            text not null check (kind in ('PROVIDER', 'DEVICE')),
    key_hash        text,
    key_created_at  timestamptz,
    is_active       boolean not null default true,
    last_seen_at    timestamptz,                            -- last request signed with the key
    created_by      bigint references users (id),
    created_at      timestamptz not null default now()
);

-- Which vehicle a device id of a source belongs to. A vehicle has at most one active tracker, and a device id of a
-- source points to at most one vehicle at a time; detached rows stay for history.
create table vehicle_trackers (
    id           bigint generated always as identity primary key,
    vehicle_id   bigint not null references vehicles (id),
    source_id    bigint not null references gps_sources (id),
    device_id    text not null check (length(device_id) between 1 and 64),   -- as the source names the device
    is_active    boolean not null default true,
    attached_by  bigint references users (id),
    attached_at  timestamptz not null default now(),
    detached_by  bigint references users (id),
    detached_at  timestamptz,
    check (is_active = (detached_at is null))
);
create unique index vehicle_trackers_vehicle_key on vehicle_trackers (vehicle_id) where is_active;
create unique index vehicle_trackers_device_key on vehicle_trackers (source_id, device_id) where is_active;

-- Device ids a source sent that no active tracker knows, so an admin can attach them to a vehicle.
create table gps_unknown_devices (
    source_id      bigint not null references gps_sources (id),
    device_id      text not null,
    first_seen_at  timestamptz not null,
    last_seen_at   timestamptz not null,                    -- when the last point of the device arrived
    last_point_at  timestamptz not null,                    -- the time of that point, as the device gave it
    point_count    integer not null default 0,
    primary key (source_id, device_id)
);

-- One position of a vehicle. trip_id is the trip the vehicle was on when the point arrived. Kept for
-- settings.gps_retention_days.
create table vehicle_positions (
    id           bigint generated always as identity primary key,
    vehicle_id   bigint not null references vehicles (id),
    trip_id      bigint references trips (id),
    at           timestamptz not null,
    lat          double precision not null check (lat between -90 and 90),
    lon          double precision not null check (lon between -180 and 180),
    speed_kph    real check (speed_kph >= 0),
    heading_deg  real check (heading_deg >= 0 and heading_deg <= 360),
    accuracy_m   real check (accuracy_m >= 0),
    source_kind  text not null check (source_kind in ('DEVICE', 'PHONE')),
    source_id    bigint references gps_sources (id),        -- the device source; null for a phone
    received_at  timestamptz not null default now(),
    check ((source_kind = 'DEVICE') = (source_id is not null)),
    unique (vehicle_id, at)
);
create index vehicle_positions_trip_idx on vehicle_positions (trip_id, at) where trip_id is not null;
create index vehicle_positions_at_idx on vehicle_positions (at);

-- The newest position of each vehicle, for the map; it only moves forward in time and is never pruned.
create table vehicle_last_positions (
    vehicle_id   bigint primary key references vehicles (id),
    trip_id      bigint references trips (id),
    at           timestamptz not null,
    lat          double precision not null,
    lon          double precision not null,
    speed_kph    real,
    heading_deg  real,
    accuracy_m   real,
    source_kind  text not null check (source_kind in ('DEVICE', 'PHONE')),
    received_at  timestamptz not null
);

-- The link a driver opens from the SPJ to share the phone's location for one trip. Issuing or reissuing the SPJ
-- revokes the old link and makes a new one. Only a hash of the token is kept; it is filled when the token is
-- first shown (the token is derived from the row id with a server secret, so the SPJ can be printed again).
create table trip_share_links (
    id          bigint generated always as identity primary key,
    trip_id     bigint not null references trips (id),
    token_hash  text unique,
    created_by  bigint references users (id),
    created_at  timestamptz not null default now(),
    revoked_at  timestamptz,
    revoked_by  bigint references users (id)
);
create unique index trip_share_links_active_key on trip_share_links (trip_id) where revoked_at is null;

-- How long points are kept; how long a customer still sees a truck after it left the plant; where the plant is
-- ({"lat": .., "lon": ..}, null until an admin sets it).
insert into settings (site_id, key, value)
select s.id, v.key, v.value::jsonb
from sites s
cross join (values
    ('gps_retention_days', '90'),
    ('gps_customer_days_after_exit', '3'),
    ('plant_location', 'null')
) as v (key, value)
on conflict do nothing;
