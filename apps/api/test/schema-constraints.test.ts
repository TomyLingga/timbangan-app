// The constraints the design relies on, exercised against the migrated schema. Ported from the phase 1
// script docs/skema/check.mjs. The scenarios build on each other, so they share one database and run in order.
// Ids are never guessed: an insert that is refused still uses up an identity value, so every row is looked
// up through a unique column.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { emptyDatabase } from "./helpers/app.js";

let database: Database;

beforeAll(async () => {
  database = await emptyDatabase();
  await migrate(database);
});

afterAll(async () => {
  await database.close();
});

const count = async (sql: string) => Number((await database.query<{ n: number }>(sql))[0]?.n);

const site = "(select id from sites where code = 'SMK')";
const partner = (name: string) => `(select id from partners where name = '${name}')`;
const user = (username: string) => `(select id from users where username = '${username}')`;
const product = (erpRef: string) => `(select id from products where erp_ref = '${erpRef}')`;
const contract = (erpRef: string) => `(select id from erp_contracts where erp_ref = '${erpRef}')`;
const vehicle = "(select id from vehicles where plate_no = 'BK8001XX')";
const driver = (licenceNo: string) => `(select id from drivers where licence_no = '${licenceNo}')`;
const registration = (regNo: string) => `(select id from registrations where reg_no = '${regNo}')`;
const allocation = (regNo: string, seq: number) =>
  `(select id from registration_allocations where registration_id = ${registration(regNo)} and seq = ${seq})`;
const trip = (seq: number) => `(select id from trips where registration_id = ${registration("REG-1")} and seq = ${seq})`;
const tripAllocation = (seq: number) => `(select id from trip_allocations where trip_id = ${trip(1)} and seq = ${seq})`;
const station = "(select id from stations where code = 'WB-IN')";
const card = "(select id from rfid_cards where uid = '0A1B2C3D')";
const destination = "(select id from destinations where name = 'Gudang C Belawan')";
const deliveryOrder = (doNo: string) => `(select id from delivery_orders where do_no = '${doNo}')`;
const exception = (status: string) => `(select id from exceptions where trip_id = ${trip(1)} and type = 'GROSS_IN' and status = '${status}')`;

const PKS = partner("PKS A");
const TRANSPORTER = partner("Transporter T");
const CUSTOMER = partner("Customer C");
const OPERATOR = user("operator");
const TRANSPORTER_USER = user("transporter-t");
const DO_550 = deliveryOrder("550/DO-LOG/XYZ/XI/2026");
const DO_551 = deliveryOrder("551/DO-LOG/XYZ/XI/2026");

let scenarios = 0;

/** The statement(s) must be accepted. A single UPDATE must also change at least one row. */
function ok(label: string, sql: string) {
  scenarios++;
  it(`accepts: ${label}`, async () => {
    const single = sql.trim().replace(/;$/, "");
    if (/^update\b/i.test(single) && !single.includes(";")) {
      expect((await database.query(`${single} returning 1`)).length).toBeGreaterThan(0);
    } else {
      await database.script(sql);
    }
  });
}

function reject(label: string, sql: string) {
  scenarios++;
  it(`rejects: ${label}`, async () => {
    await expect(database.script(sql)).rejects.toThrow();
  });
}

describe("migrated schema", () => {
  it("has the tables, indexes and reference rows of the design", async () => {
    expect(await count("select count(*) n from information_schema.tables where table_schema = 'public' and table_name <> 'schema_migrations'")).toBe(59);
    expect(await count("select count(*) n from pg_indexes where schemaname = 'public' and tablename <> 'schema_migrations'")).toBe(160);
    expect(await count("select count(*) n from flow_steps")).toBe(30);
    expect(await count("select count(*) n from modules")).toBe(21);
    // 0007 switched on the dashboard, 0009 switched off destinations, 0011 added gps
    expect(await count("select count(*) n from modules where is_active")).toBe(20);
    expect(await count("select count(*) n from flow_steps where performer_module is not null")).toBe(22);
    expect(await count("select count(*) n from zones")).toBe(9);
    expect(await count("select count(*) n from flow_steps where wait_zone_id is null or work_zone_id is null")).toBe(0);
  });

  it("has no tables for posting to the ERP", async () => {
    expect(
      await count(
        "select count(*) n from information_schema.tables where table_schema = 'public' and table_name in ('erp_outbox', 'erp_deliveries', 'delivery_assignments')",
      ),
    ).toBe(0);
  });
});

describe("constraint scenarios", () => {
  // --- fixture: one supplier, one transporter, one customer, two purchase contracts, one truck with both ---
  ok(
    "fixture",
    `
    insert into partners (erp_system, erp_ref, name, is_supplier) values ('ODOO', 'p1', 'PKS A', true);
    insert into partners (name, is_transporter) values ('Transporter T', true);
    insert into partners (erp_system, erp_ref, name, is_customer) values ('ODOO', 'p3', 'Customer C', true);
    insert into users (kind, username, full_name, sso_subject, employee_no) values ('INTERNAL', 'operator', 'Operator', '7f0c6d0e-0000-4000-8000-000000000001', '0001');
    insert into users (kind, username, full_name, password_hash, partner_id) values ('PARTNER', 'transporter-t', 'Admin Transporter T', 'x', ${TRANSPORTER});
    insert into products (erp_system, erp_ref, name, category) values ('ODOO', 'prod1', 'CPO', 'CPO'), ('ODOO', 'prod2', 'RBD Olein', 'BULK_LIQUID');
    insert into vehicles (plate_no, plate_display, vehicle_type_code, owner_partner_id, tare_kg, stnk_valid_until, tax_valid_until, kir_valid_until)
      values ('BK8001XX', 'BK 8001 XX', 'TANGKI', ${TRANSPORTER}, 15000, '2027-06-30', '2027-06-30', '2027-03-31');
    insert into drivers (full_name, licence_no, licence_class, registry_ref, registry_status) values ('Supir Satu', '0718000000001', 'B2 UMUM', '101', 'NORMAL');
    insert into erp_contracts (erp_system, erp_ref, direction, contract_no, partner_id, product_id, qty_contract, tolerance_pct, state)
      values ('ODOO', 'purchase.requisition.line,1', 'IN', '0200/K/CPO/XI/2026', ${PKS}, ${product("prod1")}, 1000000, 0.3, 'OPEN'),
             ('ODOO', 'purchase.requisition.line,2', 'IN', '0201/K/CPO/XI/2026', ${PKS}, ${product("prod1")}, 500000, 0, 'OPEN'),
             ('ODOO', 'sale.blanket.order.line,9', 'OUT', '101A/SC/FR/XYZ/X/2026', ${CUSTOMER}, ${product("prod2")}, 2000000, 0, 'OPEN');
    insert into registrations (site_id, reg_no, direction, flow_code, partner_id, transporter_id, status, created_via, created_by)
      values (${site}, 'REG-1', 'IN', 'IN_CPO', ${PKS}, ${TRANSPORTER}, 'APPROVED', 'PORTAL', ${OPERATOR});
    insert into registration_allocations (registration_id, seq, contract_id, contract_no, tolerance_pct)
      values (${registration("REG-1")}, 1, ${contract("purchase.requisition.line,1")}, '0200/K/CPO/XI/2026', 0.3),
             (${registration("REG-1")}, 2, ${contract("purchase.requisition.line,2")}, '0201/K/CPO/XI/2026', 0);
    insert into trips (site_id, registration_id, seq, status, vehicle_id, driver_id, transporter_id, plate_no, doc_gross_kg, doc_tare_kg, doc_net_kg)
      values (${site}, ${registration("REG-1")}, 1, 'CHECKED_IN', ${vehicle}, ${driver("0718000000001")}, ${TRANSPORTER}, 'BK8001XX', 40000, 15000, 25000);
    insert into trip_allocations (trip_id, registration_allocation_id, seq, spb_no, origin_gross_kg, origin_tare_kg, origin_net_kg)
      values (${trip(1)}, ${allocation("REG-1", 1)}, 1, 'SPB-1', 27000, 15000, 12000), (${trip(1)}, ${allocation("REG-1", 2)}, 2, 'SPB-2', 28000, 15000, 13000);
    insert into quality_values (parameter_code, value, source, trip_allocation_id) values ('FFA', 4.46, 'DECLARED', ${tripAllocation(1)}), ('MOISTURE', 0.27, 'DECLARED', ${tripAllocation(1)});
    insert into stations (site_id, code, name, kind) values (${site}, 'WB-IN', 'Timbangan incoming', 'WEIGHBRIDGE');
    insert into rfid_cards (site_id, uid, label) values (${site}, '0A1B2C3D', '001');
  `,
  );

  it("shows one truck with two contracts in the query a screen would run", async () => {
    const rows = await database.query<{ plate_no: string; contracts: number; doc_net: number; tolerance: number }>(`
      select t.plate_no, count(*)::int contracts, sum(a.origin_net_kg)::int doc_net, min(nullif(ra.tolerance_pct, 0))::float8 tolerance
      from trips t join trip_allocations a on a.trip_id = t.id join registration_allocations ra on ra.id = a.registration_allocation_id
      group by t.id, t.plate_no`);
    expect(rows).toEqual([{ plate_no: "BK8001XX", contracts: 2, doc_net: 25000, tolerance: 0.3 }]);
  });

  ok("card bound to the trip", `insert into card_assignments (card_id, trip_id, assigned_by) values (${card}, ${trip(1)}, ${OPERATOR})`);
  reject("same card bound twice", `insert into card_assignments (card_id, trip_id, assigned_by) values (${card}, ${trip(1)}, ${OPERATOR})`);
  ok("first weighing", `insert into weighings (trip_id, station_id, stage, kind, weight_kg, plate_check) values (${trip(1)}, ${station}, 1, 'GROSS', 40100, 'MATCH')`);
  reject(
    "second valid weighing for the same stage",
    `insert into weighings (trip_id, station_id, stage, kind, weight_kg, plate_check) values (${trip(1)}, ${station}, 1, 'GROSS', 40200, 'MATCH')`,
  );
  ok(
    "replace a weighing (void, then new)",
    `
    update weighings set status = 'VOID', voided_at = now(), void_reason = 'timbang ulang' where trip_id = ${trip(1)} and stage = 1;
    insert into weighings (trip_id, station_id, stage, kind, weight_kg, plate_check) values (${trip(1)}, ${station}, 1, 'GROSS', 40200, 'MATCH')`,
  );
  ok(
    "exception raised",
    `insert into exceptions (site_id, trip_id, type, approver_module, expected_value, actual_value, diff_pct, tolerance_pct) values (${site}, ${trip(1)}, 'GROSS_IN', 'approvals', 40000, 40200, 0.5, 0.3)`,
  );
  reject(
    "second pending exception of the same type",
    `insert into exceptions (site_id, trip_id, type, approver_module) values (${site}, ${trip(1)}, 'GROSS_IN', 'approvals')`,
  );
  reject("approval without an approver", `update exceptions set status = 'APPROVED', decision_reason = 'sesuai foto' where id = ${exception("PENDING")}`);
  reject(
    "weight difference approved without a reason",
    `update exceptions set status = 'APPROVED', decided_by = ${OPERATOR}, decided_at = now() where id = ${exception("PENDING")}`,
  );
  reject(
    "add-load decision on a gross difference",
    `update exceptions set status = 'RETRY', decision_code = 'ADD_LOAD', decided_by = ${OPERATOR}, decided_at = now() where id = ${exception("PENDING")}`,
  );
  ok(
    "truck left the platform before a decision: request cancelled, nobody decided",
    `update exceptions set status = 'CANCELLED' where id = ${exception("PENDING")}`,
  );
  ok(
    "same type raised again after the cancellation",
    `insert into exceptions (site_id, trip_id, type, approver_module) values (${site}, ${trip(1)}, 'GROSS_IN', 'approvals')`,
  );
  ok(
    "approval with approver, time and reason",
    `update exceptions set status = 'APPROVED', decided_by = ${OPERATOR}, decided_at = now(), decision_reason = 'sesuai foto' where id = ${exception("PENDING")}`,
  );
  ok("outcome known while the truck is still inside", `update trips set status = 'IN_PROCESS', outcome = 'SPEC_REJECT' where id = ${trip(1)}`);
  reject("completed with a reject outcome", `update trips set status = 'COMPLETED' where id = ${trip(1)}`);
  ok("back to a normal run", `update trips set outcome = null where id = ${trip(1)}`);

  // --- delivery order written by the logistics admin, answered by the transporter ---------------------------
  ok(
    "destination and draft delivery order without a transporter",
    `
    insert into destinations (partner_id, name, address, district, regency, province) values (${CUSTOMER}, 'Gudang C Belawan', 'Jl. Pelabuhan 1', 'Medan Belawan', 'Kota Medan', 'Sumatera Utara');
    insert into delivery_orders (site_id, do_no, do_date, contract_id, contract_no, customer_po_no, partner_id, product_id, qty, destination_id, delivery_from, created_by)
      values (${site}, '550/DO-LOG/XYZ/XI/2026', '2026-11-20', ${contract("sale.blanket.order.line,9")}, '101A/SC/FR/XYZ/X/2026', 'PO-77', ${CUSTOMER}, ${product("prod2")}, 120000, ${destination}, '2026-11-21', ${OPERATOR})`,
  );
  reject("delivery order sent without a transporter", `update delivery_orders set status = 'SENT', sent_at = now() where id = ${DO_550}`);
  ok("delivery order sent to a transporter", `update delivery_orders set status = 'SENT', sent_at = now(), transporter_id = ${TRANSPORTER} where id = ${DO_550}`);
  reject("truck count without saying who set it", `update delivery_orders set truck_count = 4 where id = ${DO_550}`);
  ok(
    "truck count set by the transporter",
    `update delivery_orders set truck_count = 4, truck_count_by = 'TRANSPORTER', status = 'ACCEPTED', accepted_by = ${TRANSPORTER_USER}, accepted_at = now() where id = ${DO_550}`,
  );
  reject(
    "same DO number twice",
    `
    insert into delivery_orders (site_id, do_no, do_date, partner_id, product_id, qty, destination_id, delivery_from, created_by)
    values (${site}, '550/DO-LOG/XYZ/XI/2026', '2026-11-20', ${CUSTOMER}, ${product("prod2")}, 1000, ${destination}, '2026-11-21', ${OPERATOR})`,
  );
  ok(
    "delivery order without a contract (transfer, waste)",
    `
    insert into delivery_orders (site_id, do_no, do_date, partner_id, product_id, qty, destination_id, delivery_from, created_by)
    values (${site}, '551/DO-LOG/XYZ/XI/2026', '2026-11-20', ${CUSTOMER}, ${product("prod2")}, 30000, ${destination}, '2026-11-21', ${OPERATOR})`,
  );
  reject(
    "outgoing request submitted without close cargo / flexi bag",
    `
    insert into registrations (site_id, reg_no, direction, flow_code, partner_id, status, created_via, created_by)
    values (${site}, 'REG-2', 'OUT', 'OUT_BULK', ${CUSTOMER}, 'SUBMITTED', 'PORTAL', ${TRANSPORTER_USER})`,
  );
  ok(
    "transporter's truck list for the delivery order",
    `
    insert into registrations (site_id, reg_no, direction, flow_code, partner_id, transporter_id, status, truck_count, qty_total, close_cargo, flexi_bag, created_via, created_by)
      values (${site}, 'REG-3', 'OUT', 'OUT_BULK', ${CUSTOMER}, ${TRANSPORTER}, 'SUBMITTED', 4, 120000, false, false, 'PORTAL', ${TRANSPORTER_USER});
    insert into registration_allocations (registration_id, seq, delivery_order_id, contract_no, do_no, qty_planned)
      values (${registration("REG-3")}, 1, ${DO_550}, '101A/SC/FR/XYZ/X/2026', '550/DO-LOG/XYZ/XI/2026', 120000)`,
  );
  reject(
    "allocation with a contract and a delivery order",
    `insert into registration_allocations (registration_id, seq, contract_id, delivery_order_id, contract_no) values (${registration("REG-3")}, 2, ${contract("sale.blanket.order.line,9")}, ${DO_551}, 'x')`,
  );
  reject("allocation with neither", `insert into registration_allocations (registration_id, seq, contract_no) values (${registration("REG-3")}, 2, 'x')`);
  reject(
    "same delivery order twice on one request",
    `insert into registration_allocations (registration_id, seq, delivery_order_id, contract_no) values (${registration("REG-3")}, 2, ${DO_550}, 'x')`,
  );
  ok(
    "second delivery order on the same request (multi DO on one truck list)",
    `insert into registration_allocations (registration_id, seq, delivery_order_id, contract_no) values (${registration("REG-3")}, 2, ${DO_551}, '-')`,
  );
  ok(
    "outgoing draft cancelled before the flags are answered",
    `
    insert into registrations (site_id, reg_no, direction, flow_code, partner_id, status, created_via, created_by) values (${site}, 'REG-9', 'OUT', 'OUT_BULK', ${CUSTOMER}, 'DRAFT', 'PORTAL', ${TRANSPORTER_USER});
    update registrations set status = 'CANCELLED' where reg_no = 'REG-9'`,
  );

  // --- vehicles, drivers, weights -------------------------------------------------------------------------
  reject(
    "same vehicle inside the plant twice",
    `insert into trips (site_id, registration_id, seq, status, vehicle_id, driver_id) values (${site}, ${registration("REG-1")}, 2, 'CHECKED_IN', ${vehicle}, ${driver("0718000000001")})`,
  );
  ok(
    "same vehicle with a future trip (issued, not arrived)",
    `
    insert into drivers (full_name, licence_no) values ('Supir Dua', '0718000000002');
    insert into trips (site_id, registration_id, seq, status, vehicle_id, driver_id) values (${site}, ${registration("REG-1")}, 2, 'ISSUED', ${vehicle}, ${driver("0718000000002")})`,
  );
  ok(
    "driver new here is queued for the central registry",
    `update drivers set registry_push = 'PENDING' where id = ${driver("0718000000002")} and registry_status = 'UNKNOWN'`,
  );
  reject("driver with a registry status that does not exist", `update drivers set registry_status = 'BANNED' where id = ${driver("0718000000002")}`);
  reject("two drivers with the same registry id", `update drivers set registry_ref = '101' where id = ${driver("0718000000002")}`);
  reject(
    "issued trip without a driver",
    `insert into trips (site_id, registration_id, seq, status, vehicle_id) values (${site}, ${registration("REG-1")}, 3, 'ISSUED', ${vehicle})`,
  );
  reject("net that is not gross minus tare", `update trips set gross_kg = 40200, tare_kg = 15100, net_kg = 25000 where id = ${trip(1)}`);
  ok("net equal to gross minus tare", `update trips set gross_kg = 40200, tare_kg = 15100, net_kg = 25100 where id = ${trip(1)}`);
  ok(
    "split of the net over two contracts",
    `
    update trip_allocations set net_kg = 12048, split_method = 'PROPORTIONAL', split_at = now() where trip_id = ${trip(1)} and seq = 1;
    update trip_allocations set net_kg = 13052, split_method = 'PROPORTIONAL', split_at = now() where trip_id = ${trip(1)} and seq = 2`,
  );
  ok(
    "master tare replaced from a weighing, with history",
    `
    insert into vehicle_tare_history (vehicle_id, tare_kg, source, reason, changed_by) values (${vehicle}, 15100, 'WEIGHING', 'disetujui atasan logistik', ${OPERATOR});
    update vehicles set tare_kg = 15100 where id = ${vehicle}`,
  );
  reject("plate with a space", `insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('BK 8002 XX', 'BK 8002 XX', 'TANGKI')`);
  reject("declared quality value without a letter", `insert into quality_values (parameter_code, value, source) values ('FFA', 4, 'DECLARED')`);
  reject("portal account without a company", `insert into users (kind, username, full_name, password_hash) values ('PARTNER', 'pks', 'PKS', 'x')`);
  reject(
    "staff account with neither portal id nor password",
    `insert into users (kind, username, full_name) values ('INTERNAL', 'tanpa-login', 'Tanpa Login')`,
  );
  reject(
    "two accounts for one portal user",
    `insert into users (kind, username, full_name, sso_subject) values ('INTERNAL', 'operator2', 'Operator', '7f0c6d0e-0000-4000-8000-000000000001')`,
  );
  ok("permission on a module", `insert into user_permissions (user_id, module_code, level) values (${OPERATOR}, 'gate', 'EDIT')`);
  reject("second permission row for the same module", `insert into user_permissions (user_id, module_code, level) values (${OPERATOR}, 'gate', 'VIEW')`);
  reject("permission on a module that does not exist", `insert into user_permissions (user_id, module_code, level) values (${OPERATOR}, 'nope', 'VIEW')`);
  reject("permission level that does not exist", `insert into user_permissions (user_id, module_code, level) values (${OPERATOR}, 'users', 'ADMIN')`);
  reject("module with a level that does not exist", `insert into modules (code, name, sort_order, levels) values ('x', 'X', 99, array['VIEW', 'DELETE'])`);
  reject("flow step done by a module that does not exist", `update flow_steps set performer_module = 'nope' where step_code = 'CHECK_IN'`);
  reject("zone colour that is not a hex colour", `insert into zones (site_id, code, name, kind, color) values (${site}, 'X', 'x', 'QC', 'merah')`);

  it("ends with the state the scenarios describe", async () => {
    expect(scenarios).toBe(53);
    const split = await database.query<{ total: number; net: number }>(
      `select sum(net_kg)::int total, (select net_kg from trips where id = ${trip(1)}) net from trip_allocations where trip_id = ${trip(1)}`,
    );
    expect(split).toEqual([{ total: 25100, net: 25100 }]);
    expect(await count(`select count(*) n from exceptions where trip_id = ${trip(1)} and status = 'APPROVED' and decision_reason = 'sesuai foto'`)).toBe(1);
    expect(await count(`select count(*) n from exceptions where trip_id = ${trip(1)} and status = 'CANCELLED'`)).toBe(1);
  });
});
