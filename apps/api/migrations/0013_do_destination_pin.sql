-- Logistics may add a map pin to the typed destination of a delivery order (owner's request, 24 November 2026), so
-- the tracking page can show where the truck is going and how far it still is. The pin is optional: a DO is made
-- and sent without one. Both parts are set or both are empty.
alter table delivery_orders add column dest_lat double precision;
alter table delivery_orders add column dest_lon double precision;
alter table delivery_orders add constraint delivery_orders_dest_pin_check check (
    (dest_lat is null and dest_lon is null)
    or (dest_lat is not null and dest_lon is not null and dest_lat between -90 and 90 and dest_lon between -180 and 180)
);
