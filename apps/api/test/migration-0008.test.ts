// 0008: tanks synced from Odoo (product label, removal mark, one tank per Odoo location), the TANK sync runs, and
// files attached to delivery orders and to trucks.
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/app.js";

describe("migration 0008", () => {
  it("lets one Odoo location be one tank only, and records TANK sync runs", async () => {
    const database = await freshDatabase();
    const insert = (code: string, erpRef: string | null) =>
      database.query("insert into storage_tanks (site_id, code, erp_ref, product_label) select id, $1, $2, 'CPO' from sites order by id limit 1", [code, erpRef]);
    await insert("TK-1", "stock.location,1");
    await insert("TK-2", null);
    await insert("TK-3", null);
    await expect(insert("TK-4", "stock.location,1")).rejects.toThrow();
    await database.query("insert into erp_sync_runs (erp_system, entity) values ('ODOO', 'TANK')");
    await expect(database.query("insert into erp_sync_runs (erp_system, entity) values ('ODOO', 'LOCATION')")).rejects.toThrow();
  });

  it("adds delivery_order_files and who linked a truck file", async () => {
    const database = await freshDatabase();
    const columns = async (table: string) =>
      (await database.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1 order by ordinal_position", [table])).map((row) => row.column_name);
    expect(await columns("delivery_order_files")).toEqual(["delivery_order_id", "file_id", "label", "added_by", "added_at"]);
    expect(await columns("trip_files")).toEqual(expect.arrayContaining(["added_by", "added_at", "label"]));
  });
});
