-- Truck owners (suppliers, customers, transporters) follow their trucks: every partner account gets gps VIEW, as new
-- partner accounts do from now on (partnerDefaults). What a partner sees stays decided by the GPS routes. A level an
-- account already holds is kept.

insert into user_permissions (user_id, module_code, level, granted_by, granted_at)
select u.id, 'gps', 'VIEW', null, now()
from users u
where u.kind = 'PARTNER'
on conflict (user_id, module_code) do nothing;
