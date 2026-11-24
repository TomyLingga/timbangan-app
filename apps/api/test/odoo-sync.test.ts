import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { OdooClient } from "../src/odoo/client.js";
import { categoryOf, syncOdoo } from "../src/odoo/sync.js";
import { freshDatabase, TestClock } from "./helpers/app.js";
import { ODOO_ENV, sampleOdooRecords, startFakeOdoo } from "./helpers/fake-odoo.js";

const odooConfig = (odoo: { url: string }) => ({ url: odoo.url, db: ODOO_ENV.ODOO_DB, uid: Number(ODOO_ENV.ODOO_UID), password: ODOO_ENV.ODOO_PASSWORD });

async function setup() {
  const database = await freshDatabase();
  const odoo = await startFakeOdoo(sampleOdooRecords());
  const clock = new TestClock();
  const client = new OdooClient({ url: odoo.url, db: ODOO_ENV.ODOO_DB, uid: Number(ODOO_ENV.ODOO_UID), password: ODOO_ENV.ODOO_PASSWORD });
  const sync = () => syncOdoo(database, client, clock.now);
  const header = (model: string, id: number) => {
    const row = odoo.records[model]?.find((item) => item.id === id);
    if (!row) throw new Error(`no ${model} ${id}`);
    return row;
  };
  return { database, odoo, clock, sync, header };
}

const contracts = (database: Database) =>
  database.query<Record<string, unknown>>(
    `select c.erp_system, c.erp_ref, c.site_id, c.direction, c.contract_no, p.erp_ref as partner_ref, pr.erp_ref as product_ref,
            c.qty_contract::float8 as qty_contract, c.qty_done_erp::float8 as qty_done_erp, c.qty_opening::float8 as qty_opening, c.customer_po_no,
            c.contract_date::text as contract_date, c.uom, c.tolerance_pct::float8 as tolerance_pct, c.certificate,
            c.valid_from::text as valid_from, c.valid_until::text as valid_until, c.state, c.raw, c.synced_at
     from erp_contracts c join partners p on p.id = c.partner_id join products pr on pr.id = c.product_id order by c.erp_ref`,
  );
const snapshot = async (database: Database) => ({
  partners: await database.query("select * from partners order by id"),
  products: await database.query("select * from products order by id"),
  contracts: await database.query("select * from erp_contracts order by id"),
});
const runs = (database: Database) =>
  database.query<{ status: string; cursor_value: string | null; rows_upserted: number; error: string | null; erp_system: string; entity: string; finished: boolean }>(
    "select erp_system, entity, status, cursor_value, rows_upserted, error, finished_at is not null as finished from erp_sync_runs order by id",
  );

describe("syncOdoo", () => {
  it("copies one row per contract line and reports the counts", async () => {
    const { database, sync, clock, header, odoo } = await setup();
    const result = await sync();
    // 5 purchase lines (the draft is skipped) + 3 sale lines (draft and the freight line are skipped)
    expect(result).toEqual({ contracts: 8, partners: 2, products: 3, skipped: 3, tanks: { status: "SKIPPED", reason: "Lokasi induk tangki di Odoo belum diatur (ODOO_TANK_PARENT_LOCATION_ID); tangki tidak disinkronkan." }, durationMs: expect.any(Number) });

    const rows = await contracts(database);
    expect(rows.map((row) => row.erp_ref)).toEqual([
      "purchase.requisition.line,101",
      "purchase.requisition.line,102",
      "purchase.requisition.line,103",
      "purchase.requisition.line,104",
      "purchase.requisition.line,105",
      "sale.blanket.order.line,201",
      "sale.blanket.order.line,203",
      "sale.blanket.order.line,204",
    ]);
    expect(rows[0]).toEqual({
      erp_system: "ODOO",
      erp_ref: "purchase.requisition.line,101",
      site_id: null,
      direction: "IN",
      contract_no: "0201/K/CPO/XI/2026",
      partner_ref: "11",
      product_ref: "21",
      qty_contract: 1000000.123,
      qty_done_erp: null,
      qty_opening: 0,
      customer_po_no: null,
      contract_date: "2026-11-01",
      uom: "kg",
      tolerance_pct: 0.3,
      certificate: "MB",
      valid_from: "2026-11-01",
      // date_end is Odoo's "agreement deadline"; in the live data it equals the ordering date, so it is not an end
      // of validity and a purchase contract gets none (trucks keep arriving after it)
      valid_until: null,
      state: "OPEN",
      raw: { header: { ...header("purchase.requisition", 1) }, line: odoo.records["purchase.requisition.line"]?.[0] },
      synced_at: clock.now(),
    });
    // `false` from Odoo: no tolerance means 0, the other fields stay empty
    expect(rows[1]).toMatchObject({ tolerance_pct: 0, certificate: null, contract_date: null, valid_from: null, valid_until: null });
    expect(rows[5]).toEqual({
      erp_system: "ODOO",
      erp_ref: "sale.blanket.order.line,201",
      site_id: null,
      direction: "OUT",
      contract_no: "101A/SC/FR/XYZ/X/2026",
      partner_ref: "12",
      product_ref: "22",
      qty_contract: 2000000,
      qty_done_erp: 150000.5,
      qty_opening: 0,
      customer_po_no: "PO-77",
      contract_date: "2026-10-15",
      uom: "kg",
      tolerance_pct: 0,
      certificate: "ISCC",
      valid_from: "2026-10-15",
      valid_until: "2026-12-31",
      state: "OPEN",
      raw: { header: { ...header("sale.blanket.order", 1) }, line: odoo.records["sale.blanket.order.line"]?.[0] },
      synced_at: clock.now(),
    });
    expect(rows[6]).toMatchObject({ customer_po_no: null, certificate: null, uom: "Karton", product_ref: "24" });
  });

  it("maps every contract state and skips drafts", async () => {
    const { database, sync } = await setup();
    await sync();
    const states = Object.fromEntries((await contracts(database)).map((row) => [row.erp_ref, row.state]));
    expect(states).toEqual({
      "purchase.requisition.line,101": "OPEN", // ongoing
      "purchase.requisition.line,102": "OPEN", // in_progress
      "purchase.requisition.line,103": "OPEN", // open
      "purchase.requisition.line,104": "CLOSED", // done
      "purchase.requisition.line,105": "CANCELLED", // cancel
      "sale.blanket.order.line,201": "OPEN", // open
      "sale.blanket.order.line,203": "OPEN", // done
      "sale.blanket.order.line,204": "CLOSED", // expired
    });
  });

  it("skips service lines, and does not copy products or partners that only skipped lines mention", async () => {
    const { database, sync } = await setup();
    await sync();
    expect(await database.query("select erp_ref from erp_contracts where erp_ref = 'sale.blanket.order.line,202'")).toEqual([]);
    expect(await database.query("select erp_ref, name from products order by erp_ref")).toEqual([
      { erp_ref: "21", name: "Crude Palm Oil" },
      { erp_ref: "22", name: "RBD Palm Olein" },
      { erp_ref: "24", name: "Minyak Goreng 1L" },
    ]);
    expect(await database.query("select erp_ref from partners order by erp_ref")).toEqual([{ erp_ref: "11" }, { erp_ref: "12" }]);
  });

  it("skips a line without a product and a contract without a partner", async () => {
    const { database, sync, odoo, header } = await setup();
    odoo.records["purchase.requisition.line"]?.push({ id: 107, requisition_id: [1, "x"], product_id: false, product_uom_id: false, product_qty: 5 });
    header("sale.blanket.order", 3).partner_id = false;
    const result = await sync();
    expect(result).toMatchObject({ contracts: 7, skipped: 5 });
    expect(await database.query("select count(*)::int as n from erp_contracts where erp_ref in ('purchase.requisition.line,107', 'sale.blanket.order.line,204')")).toEqual([{ n: 0 }]);
  });

  it("upserts partners with the flag of the side they were seen on, and never clears a flag", async () => {
    const { database, sync, clock, header } = await setup();
    await sync();
    const partnerRows = () =>
      database.query("select erp_system, erp_ref, code, name, address, is_supplier, is_customer, is_transporter, is_active, synced_at from partners order by erp_ref");
    expect(await partnerRows()).toEqual([
      { erp_system: "ODOO", erp_ref: "11", code: "V011", name: "PT PKS A", address: "Jl. Kebun 1, Simalungun", is_supplier: true, is_customer: false, is_transporter: false, is_active: true, synced_at: clock.now() },
      { erp_system: "ODOO", erp_ref: "12", code: null, name: "PT Customer C", address: null, is_supplier: false, is_customer: true, is_transporter: false, is_active: true, synced_at: clock.now() },
    ]);

    // the supplier now also buys, and an admin marked the customer as a transporter
    await database.query("update partners set is_transporter = true where erp_ref = '12'");
    Object.assign(header("sale.blanket.order", 1), { partner_id: [11, "PT PKS A"], write_date: "2026-11-12 00:00:00" });
    Object.assign(header("res.partner", 11), { name: "PT PKS A Tbk", active: false });
    await sync();
    expect(await database.query("select erp_ref, name, is_supplier, is_customer, is_transporter, is_active from partners order by erp_ref")).toEqual([
      { erp_ref: "11", name: "PT PKS A Tbk", is_supplier: true, is_customer: true, is_transporter: false, is_active: false },
      { erp_ref: "12", name: "PT Customer C", is_supplier: false, is_customer: true, is_transporter: true, is_active: true },
    ]);
  });

  it("sets the product category only when the product is inserted", async () => {
    const { database, sync, header } = await setup();
    await sync();
    const productRows = () => database.query("select erp_ref, code, name, uom, category, is_active from products order by erp_ref");
    expect(await productRows()).toEqual([
      { erp_ref: "21", code: "CPO", name: "Crude Palm Oil", uom: "kg", category: "CPO", is_active: true },
      { erp_ref: "22", code: "OLN", name: "RBD Palm Olein", uom: "kg", category: "BULK_LIQUID", is_active: true },
      { erp_ref: "24", code: "MG1", name: "Minyak Goreng 1L", uom: "Karton", category: "PACKED", is_active: false },
    ]);

    // an admin corrects the category; Odoo renames the product; the contract changes so the sync reads it again
    await database.query("update products set category = 'MATERIAL' where erp_ref = '22'");
    Object.assign(header("product.product", 22), { name: "Crude Palm Oil Olein", uom_id: [5, "Liter"] });
    header("sale.blanket.order", 1).write_date = "2026-11-12 00:00:00";
    await sync();
    expect((await productRows())[1]).toEqual({ erp_ref: "22", code: "OLN", name: "Crude Palm Oil Olein", uom: "Liter", category: "MATERIAL", is_active: true });
  });

  it("derives the category from name, location type and unit", () => {
    expect(categoryOf("Crude Palm Oil", null, "kg")).toBe("CPO");
    expect(categoryOf("CPO Super", "finish_product", "Karton")).toBe("CPO");
    // the live data has consumables named after a contract number that merely contains "CPO"
    expect(categoryOf(" 0381/XX/CPO-L/N-IV/IV/2026", null, "Unit")).toBe("PACKED");
    expect(categoryOf("Minyak eks CPO", null, "Drum")).toBe("OTHER");
    expect(categoryOf("Minyak Goreng", "finish_product", "kg")).toBe("PACKED");
    for (const unit of ["Box", "pcs", "Pouch 1L", "Unit(s)", "KARTON", "Dus"]) expect(categoryOf("Minyak Goreng", null, unit), unit).toBe("PACKED");
    for (const unit of ["kg", "Liter", "TON", "Mt"]) expect(categoryOf("RBD Olein", null, unit), unit).toBe("BULK_LIQUID");
    expect(categoryOf("Scopolamine", null, "Drum")).toBe("OTHER");
    expect(categoryOf("Tonik", null, "tonne")).toBe("OTHER");
  });

  it("changes nothing on a second run, also when every contract is read again", async () => {
    const { database, sync, clock, odoo } = await setup();
    await sync();
    const before = await snapshot(database);

    clock.advance(3_600_000);
    expect(await sync()).toMatchObject({ contracts: 0, partners: 0, products: 0, skipped: 0 });
    expect(await snapshot(database)).toEqual(before);

    // without a cursor the whole of Odoo is read again: still no row changes, not even synced_at
    await database.query("update erp_sync_runs set cursor_value = null");
    odoo.calls.length = 0;
    expect(await sync()).toMatchObject({ contracts: 0, partners: 0, products: 0, skipped: 3 });
    expect(odoo.calls.find((call) => call.model === "purchase.requisition")?.domain).toEqual([]);
    expect(await snapshot(database)).toEqual(before);
  });

  it("records each run and asks the next time only for contracts changed after the cursor", async () => {
    const { database, sync, odoo, header, clock } = await setup();
    await sync();
    expect(await runs(database)).toEqual([
      { erp_system: "ODOO", entity: "CONTRACT", status: "OK", cursor_value: "2026-11-11 03:00:04", rows_upserted: 8, error: null, finished: true },
    ]);

    // nothing changed: both header models are asked with the cursor, no lines are read, the cursor stays
    odoo.calls.length = 0;
    await sync();
    expect(odoo.calls.map((call) => [call.model, call.domain])).toEqual([
      ["purchase.requisition", [["write_date", ">", "2026-11-11 03:00:04"]]],
      ["sale.blanket.order", [["write_date", ">", "2026-11-11 03:00:04"]]],
    ]);
    expect((await runs(database))[1]).toMatchObject({ status: "OK", cursor_value: "2026-11-11 03:00:04", rows_upserted: 0 });

    // one purchase contract is closed in Odoo
    Object.assign(header("purchase.requisition", 1), { state: "done", write_date: "2026-11-20 08:30:00" });
    clock.advance(60_000);
    expect(await sync()).toMatchObject({ contracts: 1, partners: 0, products: 0 });
    expect(await database.query("select state, synced_at from erp_contracts where erp_ref = 'purchase.requisition.line,101'")).toEqual([
      { state: "CLOSED", synced_at: clock.now() },
    ]);
    expect(await database.query("select count(*)::int as n from erp_contracts where synced_at = $1", [clock.now()])).toEqual([{ n: 1 }]);
    expect((await runs(database))[2]).toMatchObject({ status: "OK", cursor_value: "2026-11-20 08:30:00", rows_upserted: 1 });
  });

  it("with full, reads every contract and takes a delivered quantity that changed without its header, and records when", async () => {
    const { database, sync, odoo, clock } = await setup();
    await sync();
    // a delivery posted in Odoo changes the line, not the header's write_date
    const line = odoo.records["sale.blanket.order.line"]?.find((row) => row.id === 201) as Record<string, unknown>;
    line.delivered_uom_qty = 160_000;
    clock.advance(60_000);
    expect(await sync()).toMatchObject({ contracts: 0 });
    const done = () => database.query("select qty_done_erp::float8 as qty from erp_contracts where erp_ref = 'sale.blanket.order.line,201'");
    expect(await done()).toEqual([{ qty: 150_000.5 }]);
    expect(await database.query("select count(*)::int as n from settings where key = 'odoo_full_sync'")).toEqual([{ n: 0 }]);

    odoo.calls.length = 0;
    clock.advance(60_000);
    expect(await syncOdoo(database, new OdooClient(odooConfig(odoo)), clock.now, { full: true })).toMatchObject({ contracts: 1 });
    expect(odoo.calls.find((call) => call.model === "sale.blanket.order")?.domain).toEqual([]);
    expect(await done()).toEqual([{ qty: 160_000 }]);
    const [lastRun] = await database.query<{ id: number }>("select id::int as id from erp_sync_runs where entity = 'CONTRACT' order by id desc limit 1");
    expect(await database.query("select site_id, value from settings where key = 'odoo_full_sync'")).toEqual([
      { site_id: null, value: { at: clock.now().toISOString(), runId: lastRun?.id } },
    ]);
    // the cursor of a full run is still the newest header seen, so the next normal run asks as before
    expect((await runs(database)).at(-1)).toMatchObject({ status: "OK", cursor_value: "2026-11-11 03:00:04" });
  });

  it("records a failure with the error text and leaves earlier data intact", async () => {
    const { database, sync, odoo, header } = await setup();
    await sync();
    const before = await snapshot(database);

    Object.assign(header("purchase.requisition", 1), { state: "done", write_date: "2026-11-20 08:30:00" });
    Object.assign(header("sale.blanket.order", 1), { state: "expired", write_date: "2026-11-20 08:31:00" });
    odoo.failWith("psycopg2.OperationalError: server closed the connection", "sale.blanket.order.line");
    await expect(sync()).rejects.toThrow(/server closed the connection/);

    expect(await snapshot(database)).toEqual(before);
    expect((await runs(database))[1]).toEqual({
      erp_system: "ODOO",
      entity: "CONTRACT",
      status: "FAILED",
      cursor_value: null,
      rows_upserted: 0,
      error: "Odoo error for sale.blanket.order.line: psycopg2.OperationalError: server closed the connection",
      finished: true,
    });

    // the next run starts from the last successful cursor and picks both changes up
    odoo.recover();
    odoo.calls.length = 0;
    expect(await sync()).toMatchObject({ contracts: 2 });
    expect(odoo.calls[0]?.domain).toEqual([["write_date", ">", "2026-11-11 03:00:04"]]);
  });

  it("sends nothing but search_read through object.execute_kw", async () => {
    const { sync, odoo } = await setup();
    await sync();
    await sync();
    expect(odoo.calls.length).toBeGreaterThan(6);
    for (const call of odoo.calls) {
      expect([call.service, call.rpcMethod, call.method]).toEqual(["object", "execute_kw", "search_read"]);
      expect(call.options.limit).toBe(500);
      expect(call.options.order).toBe("id");
    }
    expect(new Set(odoo.calls.map((call) => call.model))).toEqual(
      new Set(["purchase.requisition", "purchase.requisition.line", "sale.blanket.order", "sale.blanket.order.line", "product.product", "res.partner"]),
    );
    // archived products and partners are asked for explicitly, otherwise Odoo hides them
    expect(odoo.calls.find((call) => call.model === "product.product")?.domain).toEqual([
      ["id", "in", [21, 22, 23, 24]],
      ["active", "in", [true, false]],
    ]);
  });
});
