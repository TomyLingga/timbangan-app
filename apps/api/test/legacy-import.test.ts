// npm run legacy:import against made-up old rows (FakeLegacyReader); the old database is never touched by a test.
import { describe, expect, it } from "vitest";
import { runLegacyImport } from "../src/cli/legacy-import.js";
import type { Database } from "../src/db/client.js";
import { type ImportOptions, importLegacy } from "../src/legacy/import.js";
import type { LegacyReader } from "../src/legacy/reader.js";
import { freshDatabase, TEST_JWT_SECRET } from "./helpers/app.js";
import { FakeLegacyReader, type LegacyTables, registration, weighing } from "./helpers/fake-legacy.js";

const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, LEGACY_DATABASE_URL: "postgres://reader:unused@legacy.invalid:5432/old" };
const NOW = new Date("2026-11-24T03:00:00Z");
const clock = () => NOW;

/** The made-up old database most tests read. */
function oldRows(): Partial<LegacyTables> {
  return {
    registrasi: [
      // a plain incoming CPO truck
      registration(1),
      // a plain outgoing bulk truck of the other site
      registration(2, { jenis: "2", jenis_material: "3", signature: "SBY", origin: "001/DO-REK/REK/XI/2026", no_do: "001/DO-REK/REK/XI/2026", no_polisi: "bk-9002-xb", close_cargo: 1 }),
      // odd values: an unreadable letter weight and an empty exit time
      registration(3, { bruto_from: "abc", tgl_keluar_truk: "" }),
      // a multi-contract group: parent 4 with children 5 and 6
      registration(4, { origin: "0004/KONTRAK/REK-A/B-CD/XI/2026" }),
      registration(5, { parent_id: 4, origin: "0005/KONTRAK/REK-A/B-CD/XI/2026" }),
      registration(6, { parent_id: 4, origin: "0006/KONTRAK/REK-A/B-CD/XI/2026" }),
      registration(7, { type: "IN", finish: "4" }),
      registration(8, { jenis: "2", jenis_material: "3", type: "OUT", finish: "3" }),
      registration(9, { type: "IN", finish: "2", wight: null }),
      registration(10, { jenis: "2_", jenis_material: "" }),
      registration(11, { jenis: "", signature: "" }),
      registration(12, { tgl_entry: "2026-11-21", tgl_masuk_truk: "2026-11-21 07:00:00" }),
    ],
    timbangan: [
      weighing(101, 1),
      weighing(102, 2, { bruto: "30500.6", tarra: "12000", netto: "18501", signature: "SBY" }),
      weighing(103, 3, { bruto: "", netto: "-120", tgl_timbang1: "2026-11-20 10:5:07" }),
      weighing(104, 4, { bruto: "40000", tarra: "15000", netto: "10000" }),
      weighing(105, 5, { bruto: "40000", tarra: "15000", netto: "8000" }),
      weighing(106, 6, { bruto: "40000", tarra: "15000", netto: "7000" }),
      weighing(107, 7),
      weighing(108, 8),
      weighing(110, 10),
      weighing(111, 11),
      // registration 12 was weighed twice: the newest row counts
      weighing(120, 12, { bruto: "39000" }),
      weighing(121, 12, { bruto: "41000" }),
    ],
    qcpass: [{ id: 501, reg_id: 1, ffa: "3.10", approve: "1", approve_usr: "qc1" }],
    unload: [{ id: 601, reg_id: 1, no_pintu: "2", unloading_usr: "bongkar1" }],
    load: [{ id: 701, reg_id: 2, segel1: "LC-REK-001", segel2: "LC-REK-002", segel3: "", no_surat_coa: "COA-REK-1", nama_tangki: "T-REK-1" }],
    registrasi_wight: [
      { id: 801, reg_id: 4, bruto: 40000, tarra: 15000, netto: 10000 },
      { id: 802, reg_id: 4, bruto: 40000, tarra: 15000, netto: 15000 },
    ],
    selisih_approval: [
      { id: 1, reg_id: 1, signature: "SMK", tipe: "BRUTO_IN", status: "APPROVED", no_ticket: "5001", no_polisi: "BK 9001 XA", bruto_from: 40000, bruto_wb: 40210.4, selisih: 210.4, selisih_persen: 0.526, toleransi_persen: 0.3, requested_at: "2026-11-20T08:31:00", responded_at: "2026-11-20T08:40:00.25", responded_by: "atasan1", selisih_id: 1, note: "catatan rekaan" },
      { id: 2, reg_id: 2, signature: "SBY", tipe: "TARRA_OUT", status: "CANCELLED", requested_at: "2026-11-22T09:00:00", selisih_id: null },
    ],
    selisih: [
      { id: 1, no_ba: "BA-REK/001", tgl_ba: "2026-11-20T09:00:00", reg_id: 1, dibuat_oleh: "admin1" },
      // a report no approval points to
      { id: 2, no_ba: "BA-REK/002", tgl_ba: "2026-11-20T11:00:00", reg_id: 3, dibuat_oleh: "admin1" },
    ],
  };
}

async function run(database: Database, reader: LegacyReader, options: ImportOptions = {}) {
  return importLegacy(database, reader, { batchSize: 5, ...options }, clock);
}

type TripRow = Record<string, unknown> & { legacy_id: number; details: Record<string, unknown> };
async function trips(database: Database): Promise<TripRow[]> {
  return database.query<TripRow>(
    `select site, legacy_id::int as legacy_id, ticket_no, direction, material, state, to_char(entry_date, 'YYYY-MM-DD') as entry_date, arrived_at, left_at,
            plate_text, plate_no, reference, do_no, doc_gross_kg, doc_tare_kg, doc_net_kg, gross_kg, tare_kg, net_kg, weigh1_at, weigh2_at, weigh1_by,
            group_id::int as group_id, close_cargo, flexi_bag, details
     from legacy_trips order by legacy_id`,
  );
}
const byLegacyId = (rows: TripRow[], id: number) => rows.find((row) => row.legacy_id === id) as TripRow;

describe("legacy import: trips", () => {
  it("archives a plain incoming and a plain outgoing truck with typed searchable columns", async () => {
    const database = await freshDatabase();
    const result = await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    expect(result.parts.trips).toMatchObject({ read: 12, added: 12, changed: 0, unchanged: 0, skipped: {} });

    const rows = await trips(database);
    expect(byLegacyId(rows, 1)).toMatchObject({
      site: "SMK", ticket_no: "5001", direction: "IN", material: "CPO", state: "COMPLETED", entry_date: "2026-11-20",
      arrived_at: new Date("2026-11-20T01:00:00Z"), left_at: new Date("2026-11-20T03:00:00Z"),
      plate_text: "BK 9001 XA", plate_no: "BK9001XA", reference: "0001/KONTRAK/REK-A/B-CD/XI/2026",
      doc_gross_kg: 40_000, doc_tare_kg: 15_000, doc_net_kg: 25_000, gross_kg: 40_010, tare_kg: 15_005, net_kg: 25_005,
      weigh1_at: new Date("2026-11-20T01:30:00Z"), weigh2_at: new Date("2026-11-20T02:40:00Z"), weigh1_by: "petugas1",
      group_id: null, close_cargo: false, flexi_bag: false,
    });
    // QC and unloading in details, raw flags too, typed columns not repeated
    const details = byLegacyId(rows, 1).details;
    expect(details.qc).toEqual({ id: 501, ffa: "3.10", approve: "1", approve_usr: "qc1" });
    expect(details.unloading).toEqual({ id: 601, no_pintu: "2", unloading_usr: "bongkar1" });
    expect(details.flags).toEqual({ jenis: "1", jenis_material: "1", signature: "SMK", type: "OUT", finish: "1", wight: "1" });
    expect(details.registration).toMatchObject({ no_surat_jalan: "SJ-REK-1" });
    expect(details.registration).not.toHaveProperty("no_polisi");
    expect(details).not.toHaveProperty("original");

    expect(byLegacyId(rows, 2)).toMatchObject({ site: "SBY", direction: "OUT", material: "OUT_BULK", plate_no: "BK9002XB", do_no: "001/DO-REK/REK/XI/2026", close_cargo: true });
    // loading with its seals, certificate and tank
    expect(byLegacyId(rows, 2).details).toMatchObject({ loading: { segel1: "LC-REK-001", no_surat_coa: "COA-REK-1", nama_tangki: "T-REK-1" }, seals: ["LC-REK-001", "LC-REK-002"] });
  });

  it("rounds decimal weights, keeps negatives, and keeps the text of values it could not read", async () => {
    const database = await freshDatabase();
    const result = await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    expect(result.parts.trips?.rounded).toEqual({ "timbangan.bruto": 1 });
    // an empty value is no value; only text that is there and cannot be read counts
    expect(result.parts.trips?.unparsed).toEqual({ "registrasi.bruto_from": 1 });

    const rows = await trips(database);
    expect(byLegacyId(rows, 2)).toMatchObject({ gross_kg: 30_501, tare_kg: 12_000, net_kg: 18_501 });
    expect(byLegacyId(rows, 2).details.original).toEqual({ "timbangan.bruto": "30500.6" });
    expect(byLegacyId(rows, 3)).toMatchObject({ doc_gross_kg: null, gross_kg: null, net_kg: -120, left_at: null });
    expect(byLegacyId(rows, 3).details.original).toEqual({ "registrasi.bruto_from": "abc" });
    // the time with a one-digit minute
    expect(byLegacyId(rows, 3).weigh1_at).toEqual(new Date("2026-11-20T03:05:07Z"));
  });

  it("gives a multi-contract group the parent's id and keeps each row's net share and the split rows", async () => {
    const database = await freshDatabase();
    await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    const rows = await trips(database);
    for (const id of [4, 5, 6]) expect(byLegacyId(rows, id)).toMatchObject({ group_id: 4, gross_kg: 40_000, tare_kg: 15_000 });
    expect([4, 5, 6].map((id) => byLegacyId(rows, id).net_kg)).toEqual([10_000, 8_000, 7_000]);
    expect(byLegacyId(rows, 4).details.splits).toEqual([
      { id: 801, bruto: 40000, tarra: 15000, netto: 10000 },
      { id: 802, bruto: 40000, tarra: 15000, netto: 15000 },
    ]);
    expect(byLegacyId(rows, 1).group_id).toBeNull();
  });

  it("maps the state, the direction and the site, keeping junk values as UNKNOWN", async () => {
    const database = await freshDatabase();
    await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    const rows = await trips(database);
    expect(byLegacyId(rows, 7).state).toBe("REJECTED_QC");
    expect(byLegacyId(rows, 8).state).toBe("REJECTED_CLEANLINESS");
    expect(byLegacyId(rows, 9)).toMatchObject({ state: "UNFINISHED", gross_kg: null, weigh1_at: null });
    expect(byLegacyId(rows, 10)).toMatchObject({ direction: "UNKNOWN", material: null });
    expect(byLegacyId(rows, 10).details.flags).toMatchObject({ jenis: "2_" });
    expect(byLegacyId(rows, 11)).toMatchObject({ direction: "UNKNOWN", site: "UNKNOWN" });
    expect(new Set(rows.map((row) => row.site))).toEqual(new Set(["SMK", "SBY", "UNKNOWN"]));
  });

  it("takes the newest of two weighing rows and keeps the other in details", async () => {
    const database = await freshDatabase();
    await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    const twelve = byLegacyId(await trips(database), 12);
    expect(twelve.gross_kg).toBe(41_000);
    expect(twelve.details.weighing).toMatchObject({ id: 121 });
    expect(twelve.details.otherWeighings).toEqual([expect.objectContaining({ id: 120, bruto: "39000" })]);
  });

  it("changes nothing on a second run, and updates only the row that changed in the old database", async () => {
    const database = await freshDatabase();
    const reader = new FakeLegacyReader(oldRows());
    await run(database, reader, { only: ["trips"] });
    const before = await database.query<{ legacy_id: number; updated_at: Date; imported_at: Date }>("select legacy_id::int as legacy_id, updated_at, imported_at from legacy_trips order by legacy_id");

    const again = await run(database, reader, { only: ["trips"] });
    expect(again.parts.trips).toMatchObject({ read: 12, added: 0, changed: 0, unchanged: 12 });

    // the old application corrected one weight
    const changedRow = reader.tables.timbangan.find((row) => row.id === 101) as Record<string, unknown>;
    changedRow.netto = "25006";
    const later = new Date("2026-11-25T03:00:00Z");
    const third = await importLegacy(database, reader, { only: ["trips"], batchSize: 5 }, () => later);
    expect(third.parts.trips).toMatchObject({ read: 12, added: 0, changed: 1, unchanged: 11 });
    const after = await database.query<{ legacy_id: number; updated_at: Date; imported_at: Date; net_kg: number }>("select legacy_id::int as legacy_id, updated_at, imported_at, net_kg from legacy_trips order by legacy_id");
    expect(after.find((row) => row.legacy_id === 1)).toMatchObject({ net_kg: 25_006, updated_at: later, imported_at: before[0]?.imported_at });
    expect(after.filter((row) => row.updated_at.getTime() === later.getTime())).toHaveLength(1);
    expect(await database.query("select count(*)::int as n from legacy_trips")).toEqual([{ n: 12 }]);
  });

  it("reads only registrations entered on or after --since", async () => {
    const database = await freshDatabase();
    const result = await run(database, new FakeLegacyReader(oldRows()), { only: ["trips", "exceptions"], since: "2026-11-21" });
    expect(result.parts.trips).toMatchObject({ read: 1, added: 1 });
    expect((await trips(database)).map((row) => row.legacy_id)).toEqual([12]);
    // approvals by request date, reports by report date
    expect(result.parts.exceptions).toMatchObject({ read: 1, added: 1 });
  });

  it("writes nothing on a dry run but counts what it would write", async () => {
    const database = await freshDatabase();
    await database.query("insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('BK9101XA', 'BK 9101 XA', 'TANGKI')");
    const reader = new FakeLegacyReader({
      ...oldRows(),
      ms_truck: [{ id: 1, tipe: "TANGKI", no_polisi: "BK 9102 XA", tarra: 9000 }],
      mnosegel: [{ id: 1, nomor: "LC-REK-100", terpakai: null }],
    });
    reader.tables.registrasi[0] = { ...reader.tables.registrasi[0], rfid: "0A1B2C3D4E" };
    const tablesBefore = await counts(database);
    const result = await run(database, reader, { dryRun: true });
    expect(result.runId).toBeNull();
    expect(result.parts.trips).toMatchObject({ read: 12, added: 12 });
    expect(result.parts.exceptions).toMatchObject({ read: 3, added: 3 });
    expect(result.parts.vehicles).toMatchObject({ read: 1, added: 1 });
    expect(result.parts.seals).toMatchObject({ read: 1, added: 1 });
    expect(result.parts.cards).toMatchObject({ read: 1, added: 1 });
    expect(await counts(database)).toEqual(tablesBefore);
  });

  it("records each run that writes, with its options and counts", async () => {
    const database = await freshDatabase();
    const result = await run(database, new FakeLegacyReader(oldRows()), { only: ["trips"] });
    const [recorded] = await database.query<{ id: number; status: string; options: unknown; counts: { trips: { added: number } }; finished_at: Date | null }>(
      "select id::int as id, status, options, counts, finished_at from legacy_import_runs",
    );
    expect(recorded).toMatchObject({ id: result.runId, status: "OK", options: { only: ["trips"], since: null, resume: false }, counts: { trips: { added: 12 } }, finished_at: NOW });
  });

  it("keeps the committed batches of a run that failed and continues after them with --resume", async () => {
    const database = await freshDatabase();
    const reader = new FakeLegacyReader(oldRows());
    // the connection breaks while the second batch of five is read
    const breaking: LegacyReader = Object.assign(Object.create(reader), {
      registrations: async (afterId: number, limit: number, since: string | null) => {
        if (afterId > 0) throw new Error("connection lost");
        return reader.registrations(afterId, limit, since);
      },
    });
    await expect(run(database, breaking, { only: ["trips"] })).rejects.toThrow("connection lost");
    const [failed] = await database.query<{ status: string; progress: unknown; error: string }>("select status, progress, error from legacy_import_runs");
    expect(failed).toEqual({ status: "FAILED", progress: { trips: { after: 5, done: false } }, error: "connection lost" });
    expect(await database.query("select count(*)::int as n from legacy_trips")).toEqual([{ n: 5 }]);

    const asked: number[] = [];
    const watching: LegacyReader = Object.assign(Object.create(reader), {
      registrations: async (afterId: number, limit: number, since: string | null) => {
        asked.push(afterId);
        return reader.registrations(afterId, limit, since);
      },
    });
    const resumed = await run(database, watching, { only: ["trips"], resume: true });
    expect(asked[0]).toBe(5);
    expect(resumed.resumedFrom).toEqual(expect.any(Number));
    expect(resumed.parts.trips).toMatchObject({ read: 7, added: 7 });
    expect(await database.query("select count(*)::int as n from legacy_trips")).toEqual([{ n: 12 }]);
  });
});

describe("legacy import: exceptions", () => {
  it("archives approvals with their BA number, and BA rows no approval points to", async () => {
    const database = await freshDatabase();
    const result = await run(database, new FakeLegacyReader(oldRows()), { only: ["exceptions"] });
    expect(result.parts.exceptions).toMatchObject({ read: 3, added: 3, rounded: { "selisih_approval.bruto_wb": 1, "selisih_approval.selisih": 1 } });
    const rows = await database.query<Record<string, unknown>>(
      `select site, source, legacy_id::int as legacy_id, legacy_reg_id::int as legacy_reg_id, type, status, doc_gross_kg, weighed_gross_kg, diff_kg, diff_pct::float8 as diff_pct,
              tolerance_pct::float8 as tolerance_pct, requested_at, responded_at, responded_by, report_no, report_at, report_by, details
       from legacy_exceptions order by source, legacy_id`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        site: "SMK", source: "APPROVAL", legacy_id: 1, legacy_reg_id: 1, type: "BRUTO_IN", status: "APPROVED", doc_gross_kg: 40_000, weighed_gross_kg: 40_210, diff_kg: 210,
        diff_pct: 0.526, tolerance_pct: 0.3, requested_at: new Date("2026-11-20T01:31:00Z"), responded_at: new Date("2026-11-20T01:40:00.250Z"), responded_by: "atasan1",
        report_no: "BA-REK/001", report_at: new Date("2026-11-20T02:00:00Z"), report_by: "admin1",
      }),
      expect.objectContaining({ site: "SBY", source: "APPROVAL", legacy_id: 2, legacy_reg_id: 2, type: "TARRA_OUT", status: "CANCELLED", report_no: null }),
      expect.objectContaining({ site: "SMK", source: "REPORT", legacy_id: 2, legacy_reg_id: 3, report_no: "BA-REK/002", type: null }),
    ]);
    expect(rows[0]?.details).toMatchObject({ approval: { note: "catatan rekaan" } });
  });
});

describe("legacy import: masters", () => {
  const masters = (): Partial<LegacyTables> => ({
    registrasi: [
      registration(1, { rfid: "0a1b2c3d4e" }),
      registration(2, { rfid: "0A1B2C3D4E" }),
      registration(3, { rfid: "5F6E7D8C9B" }),
      registration(4, { rfid: "A1B2" }),
      registration(5, { rfid: "ZZZZZZZZZZ" }),
      registration(6, { rfid: "" }),
    ],
    ms_truck: [
      { id: 1, tipe: "TANGKI", no_polisi: "BK 9201 XA", tahun_produksi: "2019", daya_angkut: 30000, stnk: "2027-01-31", pajak: "2026-12-31", kir: "2026-06-30", nama_pemilik: "Pemilik Rekaan", status_kepemilikan: "SENDIRI", tarra: 12500 },
      { id: 2, tipe: "Dump Truck", no_polisi: "bk-9202-xb", tahun_produksi: "dua ribu", daya_angkut: 0, status_kepemilikan: "MITRA", tarra: 9000 },
      { id: 3, tipe: "TRONTON", no_polisi: "BK 9203 XC", status_kepemilikan: "LAIN", tarra: null },
      // the plate is already in the vehicles table: not overwritten
      { id: 4, tipe: "BOX", no_polisi: "BK 9204 XD", tarra: 7000 },
      // the same plate twice in the old master
      { id: 5, tipe: "TANGKI", no_polisi: "BK9201XA", tarra: 13000 },
      { id: 6, tipe: "TANGKI", no_polisi: "B-1", tarra: 13000 },
    ],
    mnosegel: [
      { id: 1, nomor: "LC-REK-101", terpakai: null },
      { id: 2, nomor: " LC-REK-102 ", terpakai: "" },
      { id: 3, nomor: "LC-REK-103", terpakai: "1" },
      { id: 4, nomor: "  ", terpakai: null },
      { id: 5, nomor: "LC-REK-104", terpakai: null },
      { id: 6, nomor: "LC-REK-101", terpakai: null },
    ],
  });

  async function seeded() {
    const database = await freshDatabase();
    await database.query("insert into vehicles (plate_no, plate_display, vehicle_type_code, tare_kg) values ('BK9204XD', 'BK 9204 XD', 'BAK', 6500)");
    await database.query("insert into seals (site_id, seal_no, kind, status) select id, 'LC-REK-104', 'LOCIS', 'USED' from sites where code = 'SMK'");
    await database.query("insert into rfid_cards (site_id, uid, label, status) select id, '5F6E7D8C9B', 'K-1', 'IN_USE' from sites where code = 'SMK'");
    return database;
  }

  it("adds trucks to vehicles without touching existing plates, verified at the import time, with the tare in the history", async () => {
    const database = await seeded();
    const result = await run(database, new FakeLegacyReader(masters()), { only: ["vehicles"] });
    expect(result.parts.vehicles).toMatchObject({ read: 6, added: 3, skipped: { EXISTS: 1, DUPLICATE_IN_SOURCE: 1, INVALID_PLATE: 1 }, notes: { TYPE_FALLBACK: 1 }, unparsed: { "ms_truck.tahun_produksi": 1 } });
    const rows = await database.query<Record<string, unknown>>(
      `select plate_no, plate_display, vehicle_type_code, ownership, capacity_kg, production_year, tare_kg, stnk_valid_until::text as stnk, tax_valid_until::text as tax,
              kir_valid_until::text as kir, verified_at, verified_by, owner_partner_id from vehicles order by plate_no`,
    );
    expect(rows).toEqual([
      { plate_no: "BK9201XA", plate_display: "BK 9201 XA", vehicle_type_code: "TANGKI", ownership: "SENDIRI", capacity_kg: 30_000, production_year: 2019, tare_kg: 12_500, stnk: "2027-01-31", tax: "2026-12-31", kir: "2026-06-30", verified_at: NOW, verified_by: null, owner_partner_id: null },
      { plate_no: "BK9202XB", plate_display: "BK 9202 XB", vehicle_type_code: "DUMP_TRUCK", ownership: "MITRA", capacity_kg: null, production_year: null, tare_kg: 9_000, stnk: null, tax: null, kir: null, verified_at: NOW, verified_by: null, owner_partner_id: null },
      { plate_no: "BK9203XC", plate_display: "BK 9203 XC", vehicle_type_code: "TANGKI", ownership: null, capacity_kg: null, production_year: null, tare_kg: null, stnk: null, tax: null, kir: null, verified_at: NOW, verified_by: null, owner_partner_id: null },
      expect.objectContaining({ plate_no: "BK9204XD", vehicle_type_code: "BAK", tare_kg: 6_500 }),
    ]);
    expect(await database.query("select v.plate_no, h.tare_kg, h.source from vehicle_tare_history h join vehicles v on v.id = h.vehicle_id order by v.plate_no")).toEqual([
      { plate_no: "BK9201XA", tare_kg: 12_500, source: "IMPORT" },
      { plate_no: "BK9202XB", tare_kg: 9_000, source: "IMPORT" },
    ]);
    const again = await run(database, new FakeLegacyReader(masters()), { only: ["vehicles"] });
    expect(again.parts.vehicles).toMatchObject({ added: 0, skipped: { EXISTS: 4, DUPLICATE_IN_SOURCE: 1, INVALID_PLATE: 1 } });
  });

  it("adds unused seals as available locis seals, skipping empty numbers and numbers already in stock", async () => {
    const database = await seeded();
    const result = await run(database, new FakeLegacyReader(masters()), { only: ["seals"] });
    expect(result.parts.seals).toMatchObject({ read: 5, added: 2, skipped: { EMPTY_NUMBER: 1, EXISTS: 1, DUPLICATE_IN_SOURCE: 1 } });
    expect(await database.query("select seal_no, kind, status from seals order by seal_no")).toEqual([
      { seal_no: "LC-REK-101", kind: "LOCIS", status: "AVAILABLE" },
      { seal_no: "LC-REK-102", kind: "LOCIS", status: "AVAILABLE" },
      { seal_no: "LC-REK-104", kind: "LOCIS", status: "USED" },
    ]);
  });

  it("adds the 10-character card UIDs as free cards, skipping other lengths, non-hexadecimal and known cards", async () => {
    const database = await seeded();
    const result = await run(database, new FakeLegacyReader(masters()), { only: ["cards"] });
    expect(result.parts.cards).toMatchObject({ read: 5, added: 1, skipped: { NOT_10_CHARACTERS: 1, NOT_HEXADECIMAL: 1, EXISTS: 1, DUPLICATE_IN_SOURCE: 1 } });
    expect(await database.query("select uid, label, status from rfid_cards order by uid")).toEqual([
      { uid: "0A1B2C3D4E", label: null, status: "AVAILABLE" },
      { uid: "5F6E7D8C9B", label: "K-1", status: "IN_USE" },
    ]);
  });

  it("reads only the parts --only names", async () => {
    const database = await seeded();
    const reader = new FakeLegacyReader({ ...oldRows(), ...masters() });
    const result = await run(database, reader, { only: ["seals"] });
    expect(Object.keys(result.parts)).toEqual(["seals"]);
    expect(Object.keys(reader.calls)).toEqual(["unusedSeals"]);
  });
});

async function counts(database: Database) {
  const [row] = await database.query(
    `select (select count(*)::int from legacy_trips) as trips, (select count(*)::int from legacy_exceptions) as exceptions, (select count(*)::int from legacy_import_runs) as runs,
            (select count(*)::int from vehicles) as vehicles, (select count(*)::int from vehicle_tare_history) as tares, (select count(*)::int from seals) as seals,
            (select count(*)::int from rfid_cards) as cards`,
  );
  return row;
}

describe("npm run legacy:import", () => {
  async function cli(database: Database, args: string[], reader: LegacyReader, extraEnv: Record<string, string | undefined> = {}) {
    const lines: string[] = [];
    let readerUrl: string | null = null;
    const code = await runLegacyImport(args, { ...env, ...extraEnv }, (line) => lines.push(line), {
      open: async () => ({ ...database, close: async () => {} }),
      openReader: (url) => {
        readerUrl = url;
        return reader;
      },
      now: clock,
    });
    return { code, output: lines.join("\n"), readerUrl };
  }

  it("prints counts only, never the content of a row, and says when a second run changed nothing", async () => {
    const database = await freshDatabase();
    const reader = new FakeLegacyReader(oldRows());
    const first = await cli(database, ["--only=trips,exceptions"], reader);
    expect(first.code).toBe(0);
    expect(first.readerUrl).toBe(env.LEGACY_DATABASE_URL);
    expect(reader.closed).toBe(true);
    expect(first.output).toContain("trips: dibaca 12, baru 12, berubah 0, sama 0, dilewati 0");
    expect(first.output).toContain("timbangan.bruto 1");
    for (const content of ["BK 9001 XA", "BK9001XA", "Supir Rekaan", "KONTRAK", "BA-REK", "petugas1", "30500.6", "abc"]) expect(first.output).not.toContain(content);

    const second = await cli(database, ["--only=trips,exceptions"], new FakeLegacyReader(oldRows()));
    expect(second.code).toBe(0);
    expect(second.output).toContain("trips: dibaca 12, baru 0, berubah 0, sama 12, dilewati 0");
    expect(second.output).toContain("Tidak ada perubahan");
  });

  it("says a dry run wrote nothing", async () => {
    const database = await freshDatabase();
    const result = await cli(database, ["--dry-run", "--only=trips"], new FakeLegacyReader(oldRows()));
    expect(result.code).toBe(0);
    expect(result.output).toContain("Uji coba");
    expect(await database.query("select count(*)::int as n from legacy_trips")).toEqual([{ n: 0 }]);
  });

  it("refuses to start without LEGACY_DATABASE_URL, with an unknown part, or with a bad date", async () => {
    const database = await freshDatabase();
    const reader = new FakeLegacyReader(oldRows());
    const none = await cli(database, [], reader, { LEGACY_DATABASE_URL: undefined });
    expect(none.code).toBe(1);
    expect(none.output).toContain("LEGACY_DATABASE_URL");
    expect(none.readerUrl).toBeNull();
    expect((await cli(database, ["--only=drivers"], reader)).output).toContain("--only");
    expect((await cli(database, ["--since=20-11-2026"], reader)).output).toContain("--since");
    expect((await cli(database, ["--everything"], reader)).code).toBe(1);
    expect(await database.query("select count(*)::int as n from legacy_trips")).toEqual([{ n: 0 }]);
  });

  it("prints why it stopped without the content of the failing row", async () => {
    const database = await freshDatabase();
    const failing: LegacyReader = Object.assign(Object.create(new FakeLegacyReader()), {
      registrations: async () => {
        throw new Error("statement timeout");
      },
    });
    const result = await cli(database, ["--only=trips"], failing);
    expect(result.code).toBe(1);
    expect(result.output).toContain("statement timeout");
  });
});
