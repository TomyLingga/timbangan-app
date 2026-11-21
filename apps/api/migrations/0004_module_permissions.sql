-- Access per module instead of roles (docs/rancangan-hak-akses.md). Each account gets a level per module:
-- VIEW, CREATE or EDIT, where a higher level includes the lower ones. No row means no access to that module.

create table modules (
    code             text primary key,
    name             text not null,
    sort_order       smallint not null,
    -- the levels that mean something for this module, in rising order
    levels           text[] not null check (cardinality(levels) > 0 and levels <@ array['VIEW', 'CREATE', 'EDIT']),
    -- whether the module may be given to a PARTNER account
    partner_allowed  boolean not null default false,
    -- modules of later phases exist already but cannot be granted until their phase switches them on
    is_active        boolean not null default true
);

create table user_permissions (
    user_id      bigint not null references users (id) on delete cascade,
    module_code  text not null references modules (code),
    level        text not null check (level in ('VIEW', 'CREATE', 'EDIT')),
    granted_by   bigint references users (id) on delete set null,
    granted_at   timestamptz not null default now(),
    primary key (user_id, module_code)
);

insert into modules (code, name, sort_order, levels, partner_allowed, is_active) values
    ('contracts',       'Kontrak',                      1,  array['VIEW', 'EDIT'],           true,  true),
    ('drivers',         'Supir',                        2,  array['VIEW', 'CREATE', 'EDIT'], true,  true),
    ('vehicles',        'Kendaraan',                    3,  array['VIEW', 'CREATE', 'EDIT'], true,  true),
    ('destinations',    'Tujuan',                       4,  array['VIEW', 'CREATE', 'EDIT'], false, true),
    ('delivery_orders', 'Delivery Order',               5,  array['VIEW', 'CREATE', 'EDIT'], true,  true),
    ('registrations',   'Registrasi',                   6,  array['VIEW', 'CREATE', 'EDIT'], true,  true),
    ('gate',            'Pos registrasi',               7,  array['VIEW', 'CREATE', 'EDIT'], false, true),
    ('rfid_cards',      'Kartu RFID',                   8,  array['VIEW', 'CREATE', 'EDIT'], false, true),
    ('users',           'Pengguna dan hak akses',       9,  array['VIEW', 'EDIT'],           false, true),
    -- later phases; levels are a first proposal and are settled with each phase
    ('weighbridge',     'Timbangan',                    10, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('approvals',       'Keputusan selisih dan plat',   11, array['VIEW', 'EDIT'],           false, false),
    ('qc',              'QC',                           12, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('qc_approvals',    'Keputusan QC',                 13, array['VIEW', 'EDIT'],           false, false),
    ('security_check',  'Pemeriksaan security',         14, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('unloading',       'Bongkar',                      15, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('loading',         'Muat',                         16, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('sealing',         'Segel',                        17, array['VIEW', 'CREATE', 'EDIT'], false, false),
    ('dashboard',       'Dashboard',                    18, array['VIEW'],                   false, false),
    ('reports',         'Laporan',                      19, array['VIEW'],                   false, false);

-- Role assignments become permissions. An account with several roles gets the highest level per module.
-- Roles without a line here (supervisors, QC, security, management and so on) carry over to nothing.
insert into user_permissions (user_id, module_code, level)
select g.user_id, g.module_code, (array['VIEW', 'CREATE', 'EDIT'])[max(g.rank)]
from (
    select ur.user_id, m.code as module_code, 3 as rank
    from user_roles ur
    cross join modules m
    where ur.role_code = 'SUPER_ADMIN' and m.is_active
    union all
    select ur.user_id, v.module_code, v.rank
    from user_roles ur
    join (values
        ('LOGISTICS_ADMIN',       'contracts',       3),
        ('LOGISTICS_ADMIN',       'drivers',         3),
        ('LOGISTICS_ADMIN',       'vehicles',        3),
        ('LOGISTICS_ADMIN',       'destinations',    3),
        ('LOGISTICS_ADMIN',       'delivery_orders', 3),
        ('LOGISTICS_ADMIN',       'registrations',   3),
        ('LOGISTICS_ADMIN',       'gate',            3),
        ('LOGISTICS_ADMIN',       'rfid_cards',      3),
        ('REGISTRATION_OPERATOR', 'gate',            3),
        ('REGISTRATION_OPERATOR', 'registrations',   2),
        ('REGISTRATION_OPERATOR', 'vehicles',        2),
        ('REGISTRATION_OPERATOR', 'drivers',         2),
        ('PARTNER_SUPPLIER',      'contracts',       1),
        ('PARTNER_SUPPLIER',      'registrations',   2),
        ('PARTNER_SUPPLIER',      'vehicles',        2),
        ('PARTNER_SUPPLIER',      'drivers',         2),
        ('PARTNER_TRANSPORTER',   'delivery_orders', 3),
        ('PARTNER_TRANSPORTER',   'registrations',   2),
        ('PARTNER_TRANSPORTER',   'vehicles',        2),
        ('PARTNER_TRANSPORTER',   'drivers',         2),
        ('PARTNER_CUSTOMER',      'delivery_orders', 3),
        ('PARTNER_CUSTOMER',      'registrations',   2),
        ('PARTNER_CUSTOMER',      'vehicles',        2),
        ('PARTNER_CUSTOMER',      'drivers',         2)
    ) as v (role_code, module_code, rank) on v.role_code = ur.role_code
) as g
group by g.user_id, g.module_code;

-- Columns that named a role now name the module whose holders do the work.
create temporary table role_module (role_code text primary key, module_code text not null) on commit drop;
insert into role_module values
    ('REGISTRATION_OPERATOR', 'gate'),
    ('SECURITY',              'security_check'),
    ('QC_OPERATOR',           'qc'),
    ('UNLOADING_OPERATOR',    'unloading'),
    ('LOADING_OPERATOR',      'loading'),
    ('SEAL_OPERATOR',         'sealing'),
    ('LOGISTICS_SUPERVISOR',  'approvals'),
    ('QC_SUPERVISOR',         'qc_approvals');

alter table flow_steps add column performer_module text references modules (code);
update flow_steps f set performer_module = r.module_code from role_module r where r.role_code = f.performer_role;
alter table flow_steps drop column performer_role;

alter table exception_rules add column approver_module text references modules (code);
alter table exception_rules add column escalate_module text references modules (code);
update exception_rules e set approver_module = r.module_code from role_module r where r.role_code = e.approver_role;
update exception_rules e set escalate_module = r.module_code from role_module r where r.role_code = e.escalate_role;
-- fails here when a rule names a role that has no module, instead of losing who decides
alter table exception_rules alter column approver_module set not null;
alter table exception_rules drop column approver_role;
alter table exception_rules drop column escalate_role;

alter table exceptions add column approver_module text references modules (code);
alter table exceptions add column escalated_module text references modules (code);
update exceptions e set approver_module = r.module_code from role_module r where r.role_code = e.approver_role;
update exceptions e set escalated_module = r.module_code from role_module r where r.role_code = e.escalated_role;
alter table exceptions alter column approver_module set not null;
-- dropping approver_role also drops exceptions_inbox_idx, which is made again on the module
alter table exceptions drop column approver_role;
alter table exceptions drop column escalated_role;
create index exceptions_inbox_idx on exceptions (site_id, approver_module, raised_at) where status = 'PENDING';

drop table user_roles;
drop table roles;
