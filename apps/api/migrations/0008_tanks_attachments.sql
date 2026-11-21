-- Storage tanks copied from Odoo (stock.location under one parent), and files attached to delivery orders and to
-- the trucks of a registration (the weighbridge slip of the supplier's own scale).

-- The product name Odoo keeps in the comment of a tank location ("CPO", "Olein", "PFAD"). It is kept as text,
-- whether or not a synced product matched it; the field forms match it against the truck's product when the tank
-- has no product.
alter table storage_tanks add column product_label text;
-- When the sync no longer found the tank in Odoo. Such a tank is made inactive; it becomes active again when it
-- comes back. A tank switched off here while still in Odoo keeps the local choice.
alter table storage_tanks add column erp_removed_at timestamptz;
create unique index storage_tanks_erp_ref_key on storage_tanks (erp_ref) where erp_ref is not null;

-- The tank step of the Odoo sync records its own runs.
alter table erp_sync_runs drop constraint erp_sync_runs_entity_check;
alter table erp_sync_runs add constraint erp_sync_runs_entity_check
    check (entity in ('PARTNER', 'PRODUCT', 'CONTRACT', 'DRIVER', 'TANK'));

-- The DO letter and other files logistics sends with a delivery order; the transporter reads them.
create table delivery_order_files (
    delivery_order_id  bigint not null references delivery_orders (id) on delete cascade,
    file_id            bigint not null references files (id),
    label              text,
    added_by           bigint not null references users (id),
    added_at           timestamptz not null default now(),
    primary key (delivery_order_id, file_id)
);
create index delivery_order_files_file_idx on delivery_order_files (file_id);

-- Who linked a file to a truck and when (the slip timbang a supplier attaches, label SLIP_TIMBANG).
alter table trip_files add column added_by bigint references users (id);
alter table trip_files add column added_at timestamptz;
create index trip_files_file_idx on trip_files (file_id);

-- The destination of a delivery order is typed when the DO is made and sent (owner's decision, 22 November 2026),
-- not chosen from the destinations master. Name and regency are needed for a draft, all five parts before the DO
-- is sent; the API checks both. DOs made before this keep their destination, copied here from the master row.
alter table delivery_orders add column dest_name text;
alter table delivery_orders add column dest_address text;
alter table delivery_orders add column dest_district text;   -- kecamatan
alter table delivery_orders add column dest_regency text;    -- kabupaten or kota
alter table delivery_orders add column dest_province text;
update delivery_orders d
set dest_name = t.name, dest_address = t.address, dest_district = t.district, dest_regency = t.regency, dest_province = t.province
from destinations t
where t.id = d.destination_id;
-- kept for the DOs made before, not written any more
alter table delivery_orders alter column destination_id drop not null;
