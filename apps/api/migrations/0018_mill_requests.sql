-- Several mills supply one purchase contract (owner, 26 November 2026): a contract with a trader may be delivered
-- by mill A, mill B and mill C, each with its own quantity. A shipment request now goes to one mill (the supplier),
-- which need not be the partner of the contract; a contract has at most one open request per supplier. The DO side
-- stays as it was: one open request per DO.

-- The mill (PKS) the request is sent to. Requests made before this went to the contract's own partner.
alter table shipment_requests add column supplier_id bigint references partners (id);
update shipment_requests set supplier_id = partner_id;
alter table shipment_requests alter column supplier_id set not null;
comment on column shipment_requests.partner_id is 'the partner of the contract (a trader or the mill itself)';
comment on column shipment_requests.supplier_id is 'the mill (PKS) the request is sent to; its accounts register the trucks';

drop index shipment_requests_open_contract;
-- at most one open request (a draft or a sent one) per contract and supplier; it also serves the check made when a
-- supplier registers a truck
create unique index shipment_requests_open_supplier on shipment_requests (contract_id, supplier_id) where status in ('DRAFT', 'SENT');
-- the requests of one supplier
create index shipment_requests_supplier_idx on shipment_requests (supplier_id, status);

-- Asal PKS: the mill the truck comes from. A supplier account's registration carries its own company; staff may set it
-- (the walk-in proposal fills it from the mill's name on the letter). The registration's partner_id stays the
-- partner of the contract.
alter table registrations add column origin_partner_id bigint references partners (id);
create index registrations_origin_partner_idx on registrations (origin_partner_id) where origin_partner_id is not null;
