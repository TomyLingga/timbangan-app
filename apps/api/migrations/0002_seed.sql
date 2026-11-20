-- Reference rows that the design assumes. Run after schema.sql.
-- Thresholds are the values the current system uses (November 2026); the business owns them, not IT.

insert into sites (code, name) values ('SMK', 'Sei Mangkei');

insert into roles (code, name, scope) values
    ('SUPER_ADMIN',           'Admin sistem (IT)',                 'INTERNAL'),
    ('LOGISTICS_ADMIN',       'Admin logistik',                    'INTERNAL'),
    ('REGISTRATION_OPERATOR', 'Petugas pos registrasi',            'INTERNAL'),
    ('LOGISTICS_SUPERVISOR',  'Atasan logistik (pemberi keputusan)', 'INTERNAL'),
    ('QC_OPERATOR',           'Petugas QC',                        'INTERNAL'),
    ('QC_SUPERVISOR',         'Supervisor QC',                     'INTERNAL'),
    ('SECURITY',              'Security (cek segel, cek tangki)',  'INTERNAL'),
    ('UNLOADING_OPERATOR',    'Petugas bongkar',                   'INTERNAL'),
    ('LOADING_OPERATOR',      'Petugas muat',                      'INTERNAL'),
    ('SEAL_OPERATOR',         'Petugas segel (locis)',             'INTERNAL'),
    ('MANAGEMENT',            'Manajemen (lihat saja)',            'INTERNAL'),
    ('PARTNER_SUPPLIER',      'Akun PKS / supplier',               'PARTNER'),
    ('PARTNER_TRANSPORTER',   'Akun transporter',                  'PARTNER'),
    ('PARTNER_CUSTOMER',      'Akun customer',                     'PARTNER');

insert into quality_parameters (code, name, unit, decimals, min_valid, max_valid, sort_order) values
    ('FFA',        'FFA',                    '%', 2, 0, 20, 1),
    ('MOISTURE',   'Moisture (kadar air)',   '%', 3, 0, 5,  2),
    ('IMPURITIES', 'Impurities (kotoran)',   '%', 3, 0, 5,  3);

insert into vehicle_types (code, name, is_tank, needs_container_no) values
    ('TANGKI',     'Truk tangki',  true,  false),
    ('ISO_TANK',   'ISO tank',     true,  true),
    ('KONTAINER',  'Kontainer',    false, true),
    ('BOX',        'Truk box',     false, false),
    ('BAK',        'Truk bak',     false, false),
    ('DUMP_TRUCK', 'Dump truck',   false, false);

-- Zones as coloured on the plant layout drawing.
-- The hex values are display colours chosen for the dashboard, not sampled from the drawing. map_shape (the
-- polygon of each zone on the plan) is drawn in phase 2.
insert into zones (site_id, code, name, kind, color, sort_order)
select s.id, v.code, v.name, v.kind, v.color, v.sort_order
from sites s
cross join (values
    ('REG',       'Pos registrasi (scan barcode, ambil dan kembalikan kartu)', 'REGISTRATION',  '#e53935', 1),
    ('QUEUE',     'Parkir antrean timbang',                                    'QUEUE_PARKING', '#9ccc65', 2),
    ('WB',        'Timbangan',                                                 'WEIGHBRIDGE',   '#fdd835', 3),
    ('QC',        'QC pass',                                                   'QC',            '#4fc3f7', 4),
    ('STAGING',   'Parkir sebelum muat/bongkar, cek kebersihan dan najis',     'STAGING',       '#1e3a8a', 5),
    ('DOCK',      'Loading dock produk ritel kemasan',                         'DOCK',          '#2e7d32', 6),
    ('LOADING',   'Loading',                                                   'LOADING',       '#8e24aa', 7),
    ('UNLOADING', 'Unloading',                                                 'UNLOADING',     '#f48fb1', 8),
    ('SEAL',      'Locis segel',                                               'SEALING',       '#fb8c00', 9)
) as v (code, name, kind, color, sort_order)
where s.code = 'SMK';

-- Steps per flow. on_reject = RUN marks the steps a rejected truck still passes; every other step that has
-- not been done yet is skipped. An incoming truck that is rejected leaves loaded, so its second weighing
-- records the weight it left with; an outgoing truck is rejected before loading and goes straight out.
-- The rejection path is a proposal and has to be confirmed against today's practice.
-- wait_zone / work_zone say where the dashboard draws the truck while the step is waiting or being done.
-- Where the user did not name the place of a step (seal check and tank check of incoming CPO, QC of
-- incoming goods, unloading of incoming goods), the zone is my assumption.
insert into flow_steps (site_id, flow_code, step_code, seq, name, is_optional, on_reject, performer_role, wait_zone_id, work_zone_id)
select s.id, v.flow_code, v.step_code, v.seq, v.name, v.is_optional, v.on_reject, v.performer_role, wz.id, kz.id
from sites s
cross join (values
    ('IN_CPO',     'CHECK_IN',    1, 'Scan SPJ dan ambil kartu',  false, 'SKIP', 'REGISTRATION_OPERATOR', 'REG',     'REG'),
    ('IN_CPO',     'SEAL_CHECK',  2, 'Cek segel',                 false, 'SKIP', 'SECURITY',              'SEAL',    'SEAL'),
    ('IN_CPO',     'WEIGH_1',     3, 'Timbang 1 (bruto)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('IN_CPO',     'QC',          4, 'QC pass',                   false, 'SKIP', 'QC_OPERATOR',           'QC',      'QC'),
    ('IN_CPO',     'UNLOADING',   5, 'Bongkar',                   false, 'SKIP', 'UNLOADING_OPERATOR',    'STAGING', 'UNLOADING'),
    ('IN_CPO',     'TANK_CHECK',  6, 'Cek tangki kosong',         false, 'SKIP', 'SECURITY',              'UNLOADING', 'UNLOADING'),
    ('IN_CPO',     'RESEAL',      7, 'Segel kembali (reject)',    true,  'RUN',  'SEAL_OPERATOR',         'SEAL',    'SEAL'),
    ('IN_CPO',     'WEIGH_2',     8, 'Timbang 2 (tarra)',         false, 'RUN',  null,                    'QUEUE',   'WB'),
    ('IN_CPO',     'CHECK_OUT',   9, 'Kembalikan kartu',          false, 'RUN',  'REGISTRATION_OPERATOR', 'REG',     'REG'),

    ('IN_GOODS',   'CHECK_IN',    1, 'Scan SPJ dan ambil kartu',  false, 'SKIP', 'REGISTRATION_OPERATOR', 'REG',     'REG'),
    ('IN_GOODS',   'WEIGH_1',     2, 'Timbang 1 (bruto)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('IN_GOODS',   'QC',          3, 'QC barang',                 false, 'SKIP', 'QC_OPERATOR',           'STAGING', 'STAGING'),
    ('IN_GOODS',   'UNLOADING',   4, 'Bongkar di gudang',         false, 'SKIP', 'UNLOADING_OPERATOR',    'STAGING', 'DOCK'),
    ('IN_GOODS',   'WEIGH_2',     5, 'Timbang 2 (tarra)',         false, 'RUN',  null,                    'QUEUE',   'WB'),
    ('IN_GOODS',   'CHECK_OUT',   6, 'Kembalikan kartu',          false, 'RUN',  'REGISTRATION_OPERATOR', 'REG',     'REG'),

    ('OUT_BULK',   'CHECK_IN',    1, 'Scan SPJ dan ambil kartu',  false, 'SKIP', 'REGISTRATION_OPERATOR', 'REG',     'REG'),
    ('OUT_BULK',   'WEIGH_1',     2, 'Timbang 1 (tarra)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('OUT_BULK',   'CLEANLINESS', 3, 'Cek kebersihan dan najis',  false, 'SKIP', 'QC_OPERATOR',           'STAGING', 'STAGING'),
    ('OUT_BULK',   'QC_LOADING',  4, 'QC loading',                false, 'SKIP', 'QC_OPERATOR',           'STAGING', 'LOADING'),
    ('OUT_BULK',   'LOADING',     5, 'Muat',                      false, 'SKIP', 'LOADING_OPERATOR',      'LOADING', 'LOADING'),
    ('OUT_BULK',   'SEALING',     6, 'Segel (locis)',             false, 'SKIP', 'SEAL_OPERATOR',         'SEAL',    'SEAL'),
    ('OUT_BULK',   'WEIGH_2',     7, 'Timbang 2 (bruto)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('OUT_BULK',   'CHECK_OUT',   8, 'Kembalikan kartu',          false, 'RUN',  'REGISTRATION_OPERATOR', 'REG',     'REG'),

    ('OUT_PACKED', 'CHECK_IN',    1, 'Scan SPJ dan ambil kartu',  false, 'SKIP', 'REGISTRATION_OPERATOR', 'REG',     'REG'),
    ('OUT_PACKED', 'WEIGH_1',     2, 'Timbang 1 (tarra)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('OUT_PACKED', 'CLEANLINESS', 3, 'Cek kebersihan dan najis',  false, 'SKIP', 'QC_OPERATOR',           'STAGING', 'STAGING'),
    ('OUT_PACKED', 'LOADING',     4, 'Muat di loading dock',      false, 'SKIP', 'LOADING_OPERATOR',      'STAGING', 'DOCK'),
    ('OUT_PACKED', 'SEALING',     5, 'Segel',                     false, 'SKIP', 'SEAL_OPERATOR',         'SEAL',    'SEAL'),
    ('OUT_PACKED', 'WEIGH_2',     6, 'Timbang 2 (bruto)',         false, 'SKIP', null,                    'QUEUE',   'WB'),
    ('OUT_PACKED', 'CHECK_OUT',   7, 'Kembalikan kartu',          false, 'RUN',  'REGISTRATION_OPERATOR', 'REG',     'REG')
) as v (flow_code, step_code, seq, name, is_optional, on_reject, performer_role, wait_zone, work_zone)
join zones wz on wz.site_id = s.id and wz.code = v.wait_zone
join zones kz on kz.site_id = s.id and kz.code = v.work_zone
where s.code = 'SMK';

-- Who decides which exception. GROSS_IN has no threshold here: it takes the tolerance of the contract.
-- After escalate_after_s the request is announced again; escalate_role stays empty until the business
-- names a second role that works on the phone.
-- Thresholds are the ones the current weighbridge code applies (0.1 % net in, 0.15 % tare out). Logistics
-- should review them before go-live.
insert into exception_rules (site_id, type, flow_code, threshold_pct, on_exceed, approver_role, escalate_after_s, escalate_role)
select s.id, v.type, v.flow_code, v.threshold_pct, 'APPROVAL', v.approver_role, v.escalate_after_s, null
from sites s
cross join (values
    ('PLATE',    null,       null::numeric, 'LOGISTICS_SUPERVISOR', 60),
    ('GROSS_IN', 'IN_CPO',   null,          'LOGISTICS_SUPERVISOR', 60),
    ('NET_IN',   'IN_CPO',   0.1,           'LOGISTICS_SUPERVISOR', 60),
    ('TARE_OUT', 'OUT_BULK', 0.15,          'LOGISTICS_SUPERVISOR', 60),
    ('NET_OUT',  null,       null,          'LOGISTICS_SUPERVISOR', 60),
    ('QC_HOLD',  null,       null,          'QC_SUPERVISOR',        300)
) as v (type, flow_code, threshold_pct, approver_role, escalate_after_s)
where s.code = 'SMK';

insert into settings (site_id, key, value)
select s.id, v.key, v.value::jsonb
from sites s
cross join (values
    -- most contracts on one truck, per flow (the limits of the current system)
    ('max_contracts_per_trip', '{"IN_CPO": 2, "IN_GOODS": 6, "OUT_BULK": 3, "OUT_PACKED": 6}'),
    -- direction and product category decide the flow of a registration
    ('flow_by_category', '{"IN": {"CPO": "IN_CPO", "BULK_LIQUID": "IN_GOODS", "PACKED": "IN_GOODS", "MATERIAL": "IN_GOODS", "OTHER": "IN_GOODS"}, "OUT": {"CPO": "OUT_BULK", "BULK_LIQUID": "OUT_BULK", "PACKED": "OUT_PACKED", "MATERIAL": "OUT_PACKED", "OTHER": "OUT_PACKED"}}'),
    -- placeholders, to be set by logistics: review of partner registrations, and how long an SPJ stays valid
    ('registration_review', '{"IN_CPO": "ON_FAILED_CHECK", "IN_GOODS": "ON_FAILED_CHECK", "OUT_BULK": "ON_FAILED_CHECK", "OUT_PACKED": "ON_FAILED_CHECK"}'),
    ('spj_valid_days', '7'),
    -- a driver the central registry marks BLACKLIST gets no SPJ; WARNING is shown and allowed
    ('driver_registry_policy', '{"BLACKLIST": "BLOCK", "WARNING": "WARN", "UNKNOWN": "ALLOW"}')
) as v (key, value)
where s.code = 'SMK';
