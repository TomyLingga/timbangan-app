// Only under `npm run test:pg`: the PostgreSQL legacy reader against a throwaway database on the test server that
// holds made-up rows in tables shaped like the old ones. Proves the session is read only on the server, and that
// the reader's SQL runs on a real server and feeds the importer.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it, onTestFinished } from "vitest";
import { importLegacy } from "../src/legacy/import.js";
import { LEGACY_APPLICATION_NAME, openLegacySession, PostgresLegacyReader } from "../src/legacy/reader.js";
import { freshDatabase } from "./helpers/app.js";
import { adminClient, createDatabase, dropDatabase, urlFor } from "./pg/server.js";

/** An empty database of this run, with a writable connection to fill it; dropped when the test ends. */
async function throwaway() {
  const server = inject("pgServer");
  if (!server) throw new Error("this file runs only under npm run test:pg");
  const admin = adminClient(server.url);
  const name = `tr_test_${server.run}_legacy_${randomBytes(4).toString("hex")}`;
  await createDatabase(admin, name, "template0");
  const url = urlFor(server.url, name);
  const writer = postgres(url, { max: 1, onnotice: () => {} });
  onTestFinished(async () => {
    await writer.end();
    await dropDatabase(admin, name);
    await admin.end();
  });
  return { url, writer };
}

/** Old tables with the columns the reader filters on and a few others, typed as in the old database. */
const OLD_SCHEMA = `
  create table registrasi (id bigint primary key, jenis varchar, jenis_material varchar, signature varchar, type varchar, finish character(1), wight character(1),
    no_ticket integer, no_polisi varchar, origin varchar, tgl_entry varchar, tgl_masuk_truk varchar, rfid varchar, parent_id bigint, close_cargo smallint,
    flexi_bag smallint, bruto_from varchar, product_uom_qty numeric);
  create table timbangan (id bigint primary key, reg_id bigint, bruto varchar, tarra varchar, netto varchar, tgl_timbang1 varchar, tgl_timbang2 varchar);
  create table qcpass (id bigint primary key, reg_id bigint, ffa varchar);
  create table unload (id integer primary key, reg_id bigint, no_pintu varchar);
  create table load (id integer primary key, reg_id bigint, segel1 varchar);
  create table registrasi_wight (id integer primary key, reg_id bigint, netto numeric);
  create table selisih (id bigint primary key, no_ba varchar, tgl_ba timestamp, reg_id bigint, dibuat_oleh varchar);
  create table selisih_approval (id bigint primary key, reg_id bigint, signature varchar, tipe varchar, status varchar, bruto_wb numeric,
    requested_at timestamp, selisih_id bigint);
  create table ms_truck (id bigint primary key, tipe varchar, no_polisi varchar, tahun_produksi varchar, daya_angkut integer, stnk date, pajak date, kir date,
    status_kepemilikan varchar, tarra integer);
  create table mnosegel (id bigint primary key, nomor varchar, terpakai varchar);
`;

const OLD_ROWS = `
  insert into registrasi values
    (1, '1', '1', 'SMK', 'OUT', '1', '1', 7001, 'BK 9301 XA', '0001/KONTRAK/REK/XI/2026', '2026-11-20', '2026-11-20 08:00:00', '0A1B2C3D4E', null, 0, 0, '40000', 12.5),
    (2, '1', '1', 'SMK', 'OUT', '1', '1', 7002, 'BK 9301 XA', '0002/KONTRAK/REK/XI/2026', '2026-11-20', '2026-11-20 08:00:00', null, 1, 0, 0, '40000', null),
    (3, '2', '3', 'SBY', 'IN', '2', null, 7003, 'BK 9302 XB', '001/DO-REK/XI/2026', '2026-11-22', '2026-11-22 09:00:00', 'A1B2', null, 1, 0, '', null);
  insert into timbangan values (11, 1, '40000', '15000', '10000', '2026-11-20 08:30:00', '2026-11-20 09:30:00'), (12, 2, '40000', '15000', '15000.4', null, null);
  insert into qcpass values (21, 1, '3.10');
  insert into unload values (31, 1, '2');
  insert into load values (41, 3, 'LC-REK-301');
  insert into registrasi_wight values (51, 1, 10000), (52, 1, 15000);
  insert into selisih values (61, 'BA-REK/301', '2026-11-20 09:00:00', 1, 'admin1'), (62, 'BA-REK/302', '2026-11-22 10:00:00', 3, 'admin1');
  insert into selisih_approval values (71, 1, 'SMK', 'BRUTO_IN', 'APPROVED', 40210.4, '2026-11-20 08:31:00', 61);
  insert into ms_truck values (81, 'TANGKI', 'BK 9303 XC', '2020', 30000, '2027-01-31', '2026-12-31', '2026-06-30', 'SENDIRI', 12000);
  insert into mnosegel values (91, 'LC-REK-401', null), (92, 'LC-REK-402', '1');
`;

describe("the legacy session", () => {
  it("is read only on the server: a write fails, reads work, and it names itself", async () => {
    const { url, writer } = await throwaway();
    await writer.unsafe("create table probe (id integer)").simple();
    const session = openLegacySession(url);
    onTestFinished(() => session.end());
    await expect(session.unsafe("create table other (id integer)")).rejects.toThrow(/read-only transaction/);
    await expect(session.unsafe("insert into probe values (1)")).rejects.toThrow(/read-only transaction/);
    await expect(session.begin((tx) => tx.unsafe("insert into probe values (2)"))).rejects.toThrow(/read-only transaction/);
    expect(await writer.unsafe("select count(*)::int as n from probe")).toEqual([{ n: 0 }]);
    const [settings] = await session.unsafe("select current_setting('default_transaction_read_only') as ro, current_setting('statement_timeout') as timeout, current_setting('application_name') as app");
    expect(settings).toEqual({ ro: "on", timeout: "2min", app: LEGACY_APPLICATION_NAME });
  });
});

describe("PostgresLegacyReader", () => {
  it("reads old-shaped tables in batches and feeds the importer", async () => {
    const { url, writer } = await throwaway();
    await writer.unsafe(OLD_SCHEMA).simple();
    await writer.unsafe(OLD_ROWS).simple();
    const database = await freshDatabase();
    const reader = PostgresLegacyReader.open(url);
    onTestFinished(() => reader.close());

    const first = await reader.registrations(0, 2, null);
    expect(first.map((bundle) => [bundle.registration.id, bundle.childCount, bundle.weighings.length, bundle.qc.length, bundle.unloading.length, bundle.splits.length])).toEqual([
      [1, 1, 1, 1, 1, 2],
      [2, 0, 1, 0, 0, 0],
    ]);
    // to_jsonb keeps the old types: text stays text (char(1) included), numbers are numbers
    expect(first[0]?.registration).toMatchObject({ finish: "1", no_ticket: 7001, product_uom_qty: 12.5, tgl_entry: "2026-11-20" });
    expect((await reader.registrations(2, 2, null)).map((bundle) => bundle.loading)).toEqual([[{ id: 41, reg_id: 3, segel1: "LC-REK-301" }]]);
    expect((await reader.registrations(0, 10, "2026-11-21")).map((bundle) => bundle.registration.id)).toEqual([3]);
    expect(await reader.approvals(0, 10, null)).toEqual([
      { approval: expect.objectContaining({ id: 71, bruto_wb: 40210.4, requested_at: "2026-11-20T08:31:00" }), report: expect.objectContaining({ no_ba: "BA-REK/301" }) },
    ]);
    expect(await reader.reports(0, 10, null)).toEqual([{ report: expect.objectContaining({ id: 62, no_ba: "BA-REK/302" }), site: "SBY" }]);
    expect(await reader.unusedSeals(0, 10)).toEqual([{ id: 91, nomor: "LC-REK-401", terpakai: null }]);
    expect(await reader.cardUids()).toEqual(["0A1B2C3D4E", "A1B2"]);

    const result = await importLegacy(database, reader, { batchSize: 2 }, () => new Date("2026-11-24T03:00:00Z"));
    expect(result.parts).toMatchObject({
      trips: { read: 3, added: 3, rounded: { "timbangan.netto": 1 } },
      exceptions: { read: 2, added: 2, rounded: { "selisih_approval.bruto_wb": 1 } },
      vehicles: { read: 1, added: 1 },
      seals: { read: 1, added: 1 },
      cards: { read: 2, added: 1, skipped: { NOT_10_CHARACTERS: 1 } },
    });
    expect(
      await database.query("select legacy_id::int as legacy_id, site, state, group_id::int as group_id, net_kg, weigh1_at from legacy_trips order by legacy_id"),
    ).toEqual([
      { legacy_id: 1, site: "SMK", state: "COMPLETED", group_id: 1, net_kg: 10_000, weigh1_at: new Date("2026-11-20T01:30:00Z") },
      { legacy_id: 2, site: "SMK", state: "COMPLETED", group_id: 1, net_kg: 15_000, weigh1_at: null },
      { legacy_id: 3, site: "SBY", state: "UNFINISHED", group_id: null, net_kg: null, weigh1_at: null },
    ]);
    const again = await importLegacy(database, reader, { batchSize: 2, only: ["trips", "exceptions"] }, () => new Date("2026-11-25T03:00:00Z"));
    expect(again.parts).toMatchObject({ trips: { added: 0, changed: 0, unchanged: 3 }, exceptions: { added: 0, changed: 0, unchanged: 2 } });
  });
});
