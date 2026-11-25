-- Shipment requests to suppliers (owner's flow of 25 November 2026, incoming step 1.1, and the answer "setuju"):
-- the INL team picks a purchase contract, attaches the contract PDF and sends the request to the supplier's
-- accounts. A supplier account may register incoming trucks only for a contract with a request that is sent and
-- not yet closed. One request covers one contract. Staff registering a truck at the post are not bound by it.

create table shipment_requests (
    id              bigint generated always as identity primary key,
    site_id         smallint not null references sites (id),
    contract_id     bigint not null references erp_contracts (id),    -- a purchase contract (direction IN)
    contract_no     text not null,                                    -- copied when written, so history survives the ERP
    partner_id      bigint not null references partners (id),         -- the supplier: the partner of the contract
    qty_planned     numeric(16, 3) check (qty_planned > 0),           -- optional, in the unit of the contract
    delivery_from   date,                                             -- optional delivery window
    delivery_until  date,
    remark          text,
    status          text not null default 'DRAFT' check (status in ('DRAFT', 'SENT', 'CLOSED', 'CANCELLED')),
    created_by      bigint not null references users (id),
    sent_by         bigint references users (id),
    sent_at         timestamptz,
    closed_by       bigint references users (id),
    closed_at       timestamptz,
    cancelled_by    bigint references users (id),
    cancelled_at    timestamptz,
    cancel_reason   text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    check (delivery_until is null or delivery_from is null or delivery_until >= delivery_from),
    check (status not in ('SENT', 'CLOSED') or (sent_at is not null and sent_by is not null)),
    check (status <> 'CLOSED' or (closed_at is not null and closed_by is not null)),
    check (status <> 'CANCELLED' or (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null))
);
-- at most one open request (a draft or a sent one) per contract; it also serves the check made when a supplier
-- registers a truck
create unique index shipment_requests_open_contract on shipment_requests (contract_id) where status in ('DRAFT', 'SENT');
-- the requests of one supplier
create index shipment_requests_partner_idx on shipment_requests (partner_id, status);

-- Files attached to a request (the contract PDF), uploaded through POST /api/files like the files of a DO.
create table shipment_request_files (
    shipment_request_id  bigint not null references shipment_requests (id) on delete cascade,
    file_id              bigint not null references files (id),
    label                text,
    added_by             bigint not null references users (id),
    added_at             timestamptz not null default now(),
    primary key (shipment_request_id, file_id)
);
create index shipment_request_files_file_idx on shipment_request_files (file_id);

insert into modules (code, name, sort_order, levels, partner_allowed, is_active) values
    ('shipment_requests', 'Permintaan pengiriman', 23, array['VIEW', 'CREATE', 'EDIT'], true, true);

-- Supplier accounts read the requests sent to their company, as new supplier accounts do from now on
-- (partnerDefaults). A level an account already holds is kept.
insert into user_permissions (user_id, module_code, level, granted_by, granted_at)
select u.id, 'shipment_requests', 'VIEW', null, now()
from users u
join partners p on p.id = u.partner_id
where u.kind = 'PARTNER' and p.is_supplier
on conflict (user_id, module_code) do nothing;

-- The staff who send delivery orders send these requests too: they get the level they hold on delivery orders.
insert into user_permissions (user_id, module_code, level, granted_by, granted_at)
select up.user_id, 'shipment_requests', up.level, null, now()
from user_permissions up
join users u on u.id = up.user_id
where u.kind = 'INTERNAL' and up.module_code = 'delivery_orders'
on conflict (user_id, module_code) do nothing;
