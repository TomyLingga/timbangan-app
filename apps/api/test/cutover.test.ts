// npm run cutover:opening: the opening balance of every contract line, taken once at the cut-over. Incoming lines
// from the archive of the old application (completed incoming trucks per contract number), outgoing lines from
// what Odoo counts as delivered. Every contract number, product and quantity here is invented.
import { describe, expect, it } from "vitest";
import { runCutoverOpening } from "../src/cli/cutover-opening.js";
import type { Database } from "../src/db/client.js";
import { freshDatabase, TEST_JWT_SECRET } from "./helpers/app.js";
import { seedCompany, seedContract, seedProduct } from "./helpers/fixtures.js";

const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };
const AT = new Date("2026-11-30T17:00:00Z");

let legacyId = 0;
async function archived(database: Database, reference: string | null, productName: string, netKg: number | null, extra: { direction?: string; state?: string } = {}) {
  legacyId++;
  await database.query("insert into legacy_trips (site, legacy_id, direction, state, reference, product_name, net_kg) values ('SMK', $1, $2, $3, $4, $5, $6)", [
    legacyId, extra.direction ?? "IN", extra.state ?? "COMPLETED", reference, productName, netKg,
  ]);
}

/** When the last full Odoo sync ran, as `npm run sync:odoo -- --full` records it. */
async function fullSyncAt(database: Database, at: Date) {
  await database.query("delete from settings where key = 'odoo_full_sync'");
  await database.query("insert into settings (site_id, key, value) values (null, 'odoo_full_sync', $1::jsonb)", [JSON.stringify({ at: at.toISOString(), runId: 1 })]);
}

async function seeded() {
  const database = await freshDatabase();
  const buyer = await seedCompany(database, "PT Pembeli Rekaan", { customer: true });
  const seller = await seedCompany(database, "PT Penjual Rekaan", { supplier: true });
  const olein = await seedProduct(database, "Olein Rekaan", "BULK_LIQUID");
  const boxes = await seedProduct(database, "Minyak Kemasan Rekaan", "PACKED", "Box");
  const cpo = await seedProduct(database, "CPO Rekaan", "CPO");
  const kernel = await seedProduct(database, "Kernel Rekaan", "OTHER");
  const solar = await seedProduct(database, "Solar Rekaan", "OTHER", "Liter");
  const line = async (no: string, direction: "IN" | "OUT", productId: number, uom: string, done: number | null, opening = 0) => {
    const id = await seedContract(database, { no, partnerId: direction === "IN" ? seller : buyer, productId, direction, qty: 500_000, opening, uom });
    await database.query("update erp_contracts set qty_done_erp = $2 where id = $1", [id, done]);
    return id;
  };
  const ids = {
    olein: await line("REK/JUAL/001", "OUT", olein, "kg", 120_000.5),
    olein2: await line("REK/JUAL/002", "OUT", olein, "kg", 30_000),
    boxes: await line("REK/JUAL/003", "OUT", boxes, "Box", 250),
    noErp: await line("REK/JUAL/004", "OUT", olein, "kg", null, 9),
    // one line: takes every completed incoming truck of the contract number
    single: await line("REK/BELI/001", "IN", cpo, "kg", null),
    // two lines: each takes the trucks of its product
    cpoLine: await line("REK/BELI/002", "IN", cpo, "kg", null),
    kernelLine: await line("REK/BELI/002", "IN", kernel, "kg", null),
    // nothing in the archive: left at zero
    nothing: await line("REK/BELI/003", "IN", cpo, "Kg", null, 5),
    // not kilograms: skipped
    litres: await line("REK/BELI/004", "IN", solar, "Liter", null, 7),
  };
  await archived(database, " rek/beli/001", "CPO Rekaan", 20_000);
  await archived(database, "REK/BELI/001", "CPO Rekaan", 15_000);
  await archived(database, "REK/BELI/001", "CPO Rekaan", -120);
  await archived(database, "REK/BELI/001", "CPO Rekaan", 0);
  await archived(database, "REK/BELI/001", "CPO Rekaan", 9_999, { state: "UNFINISHED" });
  await archived(database, "REK/BELI/001", "CPO Rekaan", 8_888, { direction: "OUT" });
  await archived(database, "REK/BELI/002", "cpo rekaan", 10_000);
  await archived(database, "REK/BELI/002", "KERNEL REKAAN", 4_000);
  await archived(database, "REK/BELI/002", "Cangkang Rekaan", 3_000);
  await archived(database, "REK/BELI/004", "Solar Rekaan", 1_000);
  await archived(database, "REK/LAIN/009", "CPO Rekaan", 11_000);
  await archived(database, "rek/lain/009", "CPO Rekaan", 12_000);
  await fullSyncAt(database, new Date(AT.getTime() - 10 * 60_000));
  return { database, ids };
}

const openings = async (database: Database) =>
  Object.fromEntries(
    (await database.query<{ id: number; qty_opening: string | number }>("select id::int as id, qty_opening from erp_contracts order by id")).map((row) => [row.id, Number(row.qty_opening)]),
  );

async function cli(database: Database, args: string[], at = AT) {
  const lines: string[] = [];
  const code = await runCutoverOpening(args, env, (line) => lines.push(line), async () => ({ ...database, close: async () => {} }), () => at);
  return { code, output: lines.join("\n") };
}

describe("npm run cutover:opening", () => {
  it("fills incoming lines from the archive and outgoing lines from Odoo, prints counts per direction, and records when", async () => {
    const { database, ids } = await seeded();
    const result = await cli(database, []);
    expect(result.code, result.output).toBe(0);
    const opening = await openings(database);
    expect(opening).toMatchObject({
      [ids.single]: 35_000, [ids.cpoLine]: 10_000, [ids.kernelLine]: 4_000, [ids.nothing]: 0, [ids.litres]: 7,
      [ids.olein]: 120_000.5, [ids.olein2]: 30_000, [ids.boxes]: 250, [ids.noErp]: 9,
    });
    expect(result.output).toContain("IN: 5 baris kontrak; 3 diisi dari arsip, 1 tetap nol karena tidak ada yang cocok, 1 bukan kg dilewati.");
    expect(result.output).toContain("truk arsip dengan netto nol, negatif, atau kosong, tidak dihitung: 2");
    expect(result.output).toContain("truk arsip yang tidak bisa dibagi ke baris kontrak: 1 (3000 kg)");
    expect(result.output).toContain("referensi arsip tanpa kontrak: 1 referensi, 2 truk");
    expect(result.output).toContain("IN kg: 49000");
    expect(result.output).toContain("OUT: 4 baris kontrak; 3 diisi dari Odoo, 1 tanpa angka Odoo dibiarkan.");
    expect(result.output).toContain("OUT kg: 150000.5");
    expect(result.output).toContain("OUT Box: 250");
    // counts and sums only
    expect(result.output).not.toContain("REK/");
    expect(result.output).not.toContain("Rekaan");
    const [setting] = await database.query<{ site_id: number | null; value: Record<string, unknown> }>("select site_id, value from settings where key = 'cutover_opening'");
    expect(setting).toEqual({
      site_id: null,
      value: {
        at: AT.toISOString(),
        in: { lines: 5, set: 3, zero: 1, notKg: 1, leftOutTrips: 2, unattributedTrips: 1, unattributedKg: 3_000, unmatchedReferences: 1, unmatchedTrips: 2 },
        out: { lines: 4, set: 3, withoutErp: 1 },
        changed: 7,
      },
    });
  });

  it("refuses a second run unless --again is given, and --again takes the figures as they are now", async () => {
    const { database, ids } = await seeded();
    await cli(database, []);
    await database.query("update erp_contracts set qty_done_erp = 140000 where id = $1", [ids.olein]);
    await archived(database, "REK/BELI/003", "CPO Rekaan", 6_000);
    const later = new Date("2026-12-01T01:00:00Z");
    await fullSyncAt(database, later);

    const refused = await cli(database, [], later);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("--again");
    expect(refused.output).toContain(AT.toISOString());
    expect((await openings(database))[ids.olein]).toBe(120_000.5);

    const again = await cli(database, ["--again"], later);
    expect(again.code, again.output).toBe(0);
    expect(await openings(database)).toMatchObject({ [ids.olein]: 140_000, [ids.nothing]: 6_000, [ids.single]: 35_000 });
    const rows = await database.query<{ value: { at: string; changed: number } }>("select value from settings where key = 'cutover_opening'");
    expect(rows).toEqual([{ value: expect.objectContaining({ at: later.toISOString(), changed: 2 }) }]);
  });

  it("only counts on a dry run, before and after the real run", async () => {
    const { database } = await seeded();
    const before = await openings(database);
    const dry = await cli(database, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("Uji coba");
    expect(dry.output).toContain("3 diisi dari arsip");
    expect(await openings(database)).toEqual(before);
    expect(await database.query("select count(*)::int as n from settings where key = 'cutover_opening'")).toEqual([{ n: 0 }]);

    await cli(database, []);
    const after = await cli(database, ["--dry-run"]);
    expect(after.code).toBe(0);
    expect(after.output).toContain(AT.toISOString());
    expect(await database.query("select value->>'at' as at from settings where key = 'cutover_opening'")).toEqual([{ at: AT.toISOString() }]);
  });

  it("refuses when the last full Odoo sync is missing or older than an hour, unless --stale-ok is given", async () => {
    const { database, ids } = await seeded();
    await database.query("delete from settings where key = 'odoo_full_sync'");
    const never = await cli(database, []);
    expect(never.code).toBe(1);
    expect(never.output).toContain("npm run sync:odoo -- --full");
    expect(never.output).toContain("--stale-ok");

    await fullSyncAt(database, new Date(AT.getTime() - 61 * 60_000));
    const old = await cli(database, []);
    expect(old.code).toBe(1);
    expect(old.output).toContain("2026-11-30T15:59:00.000Z");
    expect(await database.query("select count(*)::int as n from settings where key = 'cutover_opening'")).toEqual([{ n: 0 }]);
    // a dry run only warns
    const dry = await cli(database, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("sync:odoo -- --full");

    const forced = await cli(database, ["--stale-ok"]);
    expect(forced.code, forced.output).toBe(0);
    expect((await openings(database))[ids.olein]).toBe(120_000.5);
  });

  it("refuses an unknown option", async () => {
    const { database } = await seeded();
    const result = await cli(database, ["--force"]);
    expect(result.code).toBe(1);
    expect(await database.query("select count(*)::int as n from settings where key = 'cutover_opening'")).toEqual([{ n: 0 }]);
  });
});
