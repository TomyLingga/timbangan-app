// The tank step of the Odoo sync: internal children of one stock.location become storage tanks.
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { OdooClient } from "../src/odoo/client.js";
import { syncOdoo } from "../src/odoo/sync.js";
import { freshDatabase, TestClock } from "./helpers/app.js";
import { ODOO_ENV, sampleOdooRecords, startFakeOdoo } from "./helpers/fake-odoo.js";

async function setup(tankParentLocationId: number | null = 40) {
  const database = await freshDatabase();
  const odoo = await startFakeOdoo(sampleOdooRecords());
  const clock = new TestClock();
  const client = new OdooClient({ url: odoo.url, db: ODOO_ENV.ODOO_DB, uid: Number(ODOO_ENV.ODOO_UID), password: ODOO_ENV.ODOO_PASSWORD });
  const sync = () => syncOdoo(database, client, clock.now, { tankParentLocationId });
  const location = (id: number) => {
    const row = odoo.records["stock.location"]?.find((item) => item.id === id);
    if (!row) throw new Error(`no location ${id}`);
    return row;
  };
  return { database, odoo, clock, sync, location };
}

const tanks = (database: Database) =>
  database.query<Record<string, unknown>>(
    `select t.erp_ref, t.code, t.name, p.erp_ref as product_ref, t.product_label, t.is_active, t.erp_removed_at is not null as removed
     from storage_tanks t left join products p on p.id = t.product_id order by t.code`,
  );
const tankRuns = (database: Database) =>
  database.query<{ status: string; rows_upserted: number; error: string | null }>("select status, rows_upserted, error from erp_sync_runs where entity = 'TANK' order by id");

describe("syncOdoo, tank step", () => {
  it("copies the active internal children of the parent location, matching the comment to a synced product", async () => {
    const { database, sync, odoo } = await setup();
    const result = await sync();
    expect(result.tanks).toEqual({ status: "OK", written: 4, deactivated: 0, skipped: 0 });
    expect(await tanks(database)).toEqual([
      // "CPO" is the code of the synced product
      { erp_ref: "stock.location,301", code: "TK-101", name: "WH/Tangki/TK-101", product_ref: "21", product_label: "CPO", is_active: true, removed: false },
      // the name, in any case
      { erp_ref: "stock.location,302", code: "TK-102", name: "WH/Tangki/TK-102", product_ref: "22", product_label: "rbd palm olein", is_active: true, removed: false },
      // no synced product is called PFAD: the comment stays as text
      { erp_ref: "stock.location,303", code: "TK-201", name: "WH/Tangki/TK-201", product_ref: null, product_label: "PFAD", is_active: true, removed: false },
      { erp_ref: "stock.location,304", code: "TK-301", name: "WH/Tangki/TK-301", product_ref: null, product_label: null, is_active: true, removed: false },
    ]);
    const call = odoo.calls.find((item) => item.model === "stock.location");
    expect(call?.domain).toEqual([
      ["location_id", "=", 40],
      ["usage", "=", "internal"],
      ["active", "=", true],
    ]);
    expect(call?.options.fields).toEqual(["id", "name", "complete_name", "comment", "active", "location_id"]);
    expect(call?.method).toBe("search_read");
    expect(await tankRuns(database)).toEqual([{ status: "OK", rows_upserted: 4, error: null }]);
  });

  it("changes nothing on a second run", async () => {
    const { database, sync, clock } = await setup();
    await sync();
    const before = await database.query("select * from storage_tanks order by id");
    clock.advance(60_000);
    expect((await sync()).tanks).toEqual({ status: "OK", written: 0, deactivated: 0, skipped: 0 });
    expect(await database.query("select * from storage_tanks order by id")).toEqual(before);
  });

  it("follows renames and comment changes, makes a vanished tank inactive without deleting it, and wakes it when it returns", async () => {
    const { database, sync, odoo, location } = await setup();
    await sync();
    Object.assign(location(303), { name: "TK-202", complete_name: "WH/Tangki/TK-202", comment: "CPO" });
    const gone = odoo.records["stock.location"]?.splice(3, 1) ?? [];
    expect((await sync()).tanks).toEqual({ status: "OK", written: 1, deactivated: 1, skipped: 0 });
    const rows = await tanks(database);
    expect(rows.find((row) => row.erp_ref === "stock.location,303")).toMatchObject({ code: "TK-202", product_ref: "21", product_label: "CPO", is_active: true });
    expect(rows.find((row) => row.erp_ref === "stock.location,304")).toMatchObject({ is_active: false, removed: true });
    expect(rows).toHaveLength(4);

    odoo.records["stock.location"]?.push(...gone);
    expect((await sync()).tanks).toMatchObject({ written: 1, deactivated: 0 });
    expect((await tanks(database)).find((row) => row.erp_ref === "stock.location,304")).toMatchObject({ is_active: true, removed: false });
  });

  it("keeps a tank switched off here while it is still in Odoo", async () => {
    const { database, sync } = await setup();
    await sync();
    await database.query("update storage_tanks set is_active = false where erp_ref = 'stock.location,301'");
    expect((await sync()).tanks).toMatchObject({ written: 0, deactivated: 0 });
    expect((await tanks(database))[0]).toMatchObject({ erp_ref: "stock.location,301", is_active: false, removed: false });
  });

  it("takes over a local tank with the same code instead of adding a second one", async () => {
    const { database, sync } = await setup();
    await database.query("insert into storage_tanks (site_id, code, name, capacity_kg) select id, 'TK-101', 'Tangki lama', 500000 from sites order by id limit 1");
    await sync();
    expect(await database.query("select code, name, erp_ref, capacity_kg::int as capacity_kg from storage_tanks where code = 'TK-101'")).toEqual([
      { code: "TK-101", name: "WH/Tangki/TK-101", erp_ref: "stock.location,301", capacity_kg: 500000 },
    ]);
  });

  it("skips a location whose code another synced tank already holds", async () => {
    const { database, sync, location } = await setup();
    location(304).name = "TK-101";
    expect((await sync()).tanks).toEqual({ status: "OK", written: 3, deactivated: 0, skipped: 1 });
    expect(await database.query("select count(*)::int as n from storage_tanks")).toEqual([{ n: 3 }]);
  });

  it("is skipped and says so when no parent location is configured", async () => {
    const { database, sync, odoo } = await setup(null);
    const result = await sync();
    expect(result.tanks).toEqual({ status: "SKIPPED", reason: "Lokasi induk tangki di Odoo belum diatur (ODOO_TANK_PARENT_LOCATION_ID); tangki tidak disinkronkan." });
    expect(odoo.calls.some((call) => call.model === "stock.location")).toBe(false);
    expect(await tankRuns(database)).toEqual([]);
    expect(await database.query("select count(*)::int as n from storage_tanks")).toEqual([{ n: 0 }]);
  });

  it("records a failed tank step and keeps the contracts of the same run", async () => {
    const { database, sync, odoo } = await setup();
    odoo.failWith("access to stock.location denied", "stock.location");
    await expect(sync()).rejects.toThrow(/stock.location denied/);
    expect(await tankRuns(database)).toEqual([{ status: "FAILED", rows_upserted: 0, error: "Odoo error for stock.location: access to stock.location denied" }]);
    expect(await database.query("select status from erp_sync_runs where entity = 'CONTRACT'")).toEqual([{ status: "OK" }]);
    expect(await database.query("select count(*)::int as n from erp_contracts")).toEqual([{ n: 8 }]);
  });
});
