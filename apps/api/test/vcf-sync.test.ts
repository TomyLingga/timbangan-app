import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import { VcfClient, VcfError } from "../src/vcf/client.js";
import { syncVcf } from "../src/vcf/sync.js";
import { freshDatabase, TEST_JWT_SECRET, TestClock } from "./helpers/app.js";
import { type RegistryRow, registryDriver, registryTransporter, startFakeVcf } from "./helpers/fake-vcf.js";

async function setup(data: { drivers?: RegistryRow[]; transporters?: RegistryRow[] } = {}) {
  const database = await freshDatabase();
  const vcf = await startFakeVcf(data);
  const clock = new TestClock();
  const sync = () => syncVcf(database, new VcfClient(vcf.url), clock.now);
  return { database, vcf, clock, sync };
}

const driverRows = (database: Database) =>
  database.query<Record<string, unknown>>(
    `select full_name, licence_no, licence_class, licence_valid_until::text as licence_valid_until, registry_ref, registry_status,
            registry_synced_at, registry_push, is_active from drivers order by licence_no`,
  );
const runs = (database: Database) =>
  database.query("select erp_system, entity, status, rows_upserted, error, finished_at is not null as finished from erp_sync_runs order by id");

describe("configuration", () => {
  it("needs only VCF_URL to read the registry", () => {
    const base = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };
    expect(loadConfig({ ...base, VCF_URL: "http://registry.test/" }).vcf).toEqual({ url: "http://registry.test", username: null, password: null });
    expect(loadConfig({ ...base, VCF_URL: "http://registry.test", VCF_USERNAME: "reader", VCF_PASSWORD: "secret" }).vcf).toEqual({
      url: "http://registry.test",
      username: "reader",
      password: "secret",
    });
    expect(loadConfig({ ...base, VCF_USERNAME: "reader", VCF_PASSWORD: "secret" }).vcf).toBeNull();
  });
});

describe("VcfClient", () => {
  it("reads drivers and transporters with two GET requests and nothing else", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)], transporters: [registryTransporter(7)] });
    const client = new VcfClient(vcf.url);
    expect(await client.drivers()).toEqual([registryDriver(1)]);
    expect(await client.transporters()).toEqual([registryTransporter(7)]);
    expect(vcf.requests).toEqual([
      { method: "GET", url: "/api/master/drivers" },
      { method: "GET", url: "/api/master/transporters" },
    ]);
  });

  it("turns an error status, an answer without data and an unreachable server into a VcfError", async () => {
    const vcf = await startFakeVcf();
    vcf.failWith(500);
    await expect(new VcfClient(vcf.url).drivers()).rejects.toThrow(VcfError);
    await expect(new VcfClient(vcf.url).drivers()).rejects.toThrow(/HTTP 500/);
    vcf.recover();
    // an answer without a `data` list
    vcf.failWith(200);
    await expect(new VcfClient(vcf.url).transporters()).rejects.toThrow(/gave no data/);
    await vcf.close();
    await expect(new VcfClient(vcf.url).transporters()).rejects.toThrow(/cannot be reached/);
  });
});

describe("syncVcf: drivers", () => {
  it("copies drivers with a normalised licence number and the registry status", async () => {
    const { database, sync, clock } = await setup({
      drivers: [
        registryDriver(1, { nama_supir: "  Supir Satu ", no_sim: "1100-0000 00ab", status: "warning", tgl_berlaku_sim: "2027-01-31T00:00:00.000000Z" }),
        registryDriver(2, { status: "blacklist", is_active: false, jenis_sim: null, tgl_berlaku_sim: null }),
        registryDriver(3, { status: "something-new", is_active: 1 }),
      ],
    });
    expect(await sync()).toEqual({ drivers: 3, transporters: 0, skipped: 0, pushed: 0, pushFailed: 0, durationMs: expect.any(Number) });
    expect(await driverRows(database)).toEqual([
      { full_name: "Supir Satu", licence_no: "1100000000AB", licence_class: "B2 UMUM", licence_valid_until: "2027-01-31", registry_ref: "1", registry_status: "WARNING", registry_synced_at: clock.now(), registry_push: "NONE", is_active: true },
      { full_name: "Supir 2", licence_no: "990000000002", licence_class: null, licence_valid_until: null, registry_ref: "2", registry_status: "BLACKLIST", registry_synced_at: clock.now(), registry_push: "NONE", is_active: false },
      { full_name: "Supir 3", licence_no: "990000000003", licence_class: "B2 UMUM", licence_valid_until: "2028-05-31", registry_ref: "3", registry_status: "UNKNOWN", registry_synced_at: clock.now(), registry_push: "NONE", is_active: true },
    ]);
  });

  it("skips and counts rows without a usable licence number or name", async () => {
    const { database, sync } = await setup({
      drivers: [
        registryDriver(1),
        registryDriver(2, { no_sim: "12-34" }),
        registryDriver(3, { no_sim: null }),
        registryDriver(4, { no_sim: "1".repeat(21) }),
        registryDriver(5, { nama_supir: "   " }),
        registryDriver(6, { nama_supir: null }),
      ],
    });
    expect(await sync()).toMatchObject({ drivers: 1, skipped: 5 });
    expect((await driverRows(database)).map((row) => row.registry_ref)).toEqual(["1"]);
  });

  it("keeps the row with the worse status when two registry rows share a licence number", async () => {
    const { database, sync } = await setup({
      drivers: [
        registryDriver(1, { no_sim: "AAA 111 222", status: "normal" }),
        registryDriver(2, { no_sim: "aaa111222", status: "blacklist", nama_supir: "Yang Diblokir" }),
        registryDriver(3, { no_sim: "AAA-111-222", status: "warning" }),
        registryDriver(4, { no_sim: "BBB111222", status: "warning", nama_supir: "Pertama" }),
        registryDriver(5, { no_sim: "BBB111222", status: "warning" }),
      ],
    });
    expect(await sync()).toMatchObject({ drivers: 2, skipped: 3 });
    expect((await driverRows(database)).map((row) => [row.licence_no, row.registry_ref, row.registry_status, row.full_name])).toEqual([
      ["AAA111222", "2", "BLACKLIST", "Yang Diblokir"],
      ["BBB111222", "4", "WARNING", "Pertama"],
    ]);
  });

  it("matches an existing driver by registry id first, then by licence number, and leaves other local drivers alone", async () => {
    const { database, sync, clock } = await setup({
      drivers: [
        registryDriver(10, { no_sim: "NEW000010", nama_supir: "Nama Baru", status: "warning" }),
        registryDriver(11, { no_sim: "loc-000011", status: "blacklist" }),
      ],
    });
    await database.script(`
      insert into drivers (full_name, licence_no, registry_ref, registry_status) values ('Nama Lama', 'OLD000010', '10', 'NORMAL');
      insert into drivers (full_name, licence_no, registry_push, phone) values ('Supir Lokal', 'LOC000011', 'PENDING', '0800');
      insert into drivers (full_name, licence_no, registry_push) values ('Hanya Di Sini', 'ONLYHERE01', 'PENDING');
    `);

    expect(await sync()).toMatchObject({ drivers: 2, skipped: 0 });
    expect((await driverRows(database)).map((row) => [row.licence_no, row.full_name, row.registry_ref, row.registry_status, row.registry_push, row.registry_synced_at])).toEqual([
      // matched by licence number: the pending push is settled, the phone number stays
      ["LOC000011", "Supir 11", "11", "BLACKLIST", "NONE", clock.now()],
      // matched by registry id: the licence number kept here is not replaced
      ["OLD000010", "Nama Baru", "10", "WARNING", "NONE", clock.now()],
      // absent from the registry: untouched
      ["ONLYHERE01", "Hanya Di Sini", null, "UNKNOWN", "PENDING", null],
    ]);
    expect(await database.query("select phone from drivers where licence_no = 'LOC000011'")).toEqual([{ phone: "0800" }]);
  });

  it("does not attach a registry row to a driver that already belongs to another registry id", async () => {
    const { database, sync } = await setup({ drivers: [registryDriver(21, { no_sim: "DUP000001", nama_supir: "Orang Lain" })] });
    await database.script("insert into drivers (full_name, licence_no, registry_ref, registry_status) values ('Pemilik', 'DUP000001', '20', 'NORMAL')");
    expect(await sync()).toMatchObject({ drivers: 0, skipped: 1 });
    expect((await driverRows(database)).map((row) => [row.full_name, row.registry_ref])).toEqual([["Pemilik", "20"]]);
  });
});

describe("syncVcf: transporters", () => {
  it("copies transporters into partners under the code VCF-<id> and never touches rows from Odoo", async () => {
    const { database, sync, vcf } = await setup({
      transporters: [registryTransporter(7, { nama_transporter: " PT Angkut Tujuh " }), registryTransporter(8, { is_active: 0 }), registryTransporter(9, { nama_transporter: "" })],
    });
    await database.script(`
      insert into partners (erp_system, erp_ref, code, name, is_supplier) values ('ODOO', '55', 'VCF-7', 'Dari Odoo', true);
      insert into partners (code, name) values ('VCF-8', 'Nama Lama');
    `);
    const partnerRows = () => database.query("select erp_system, code, name, is_supplier, is_customer, is_transporter, is_active from partners order by code, name");

    expect(await sync()).toMatchObject({ drivers: 0, transporters: 2, skipped: 1 });
    expect(await partnerRows()).toEqual([
      { erp_system: "ODOO", code: "VCF-7", name: "Dari Odoo", is_supplier: true, is_customer: false, is_transporter: false, is_active: true },
      { erp_system: null, code: "VCF-7", name: "PT Angkut Tujuh", is_supplier: false, is_customer: false, is_transporter: true, is_active: true },
      { erp_system: null, code: "VCF-8", name: "Transporter 8", is_supplier: false, is_customer: false, is_transporter: true, is_active: false },
    ]);

    vcf.transporters[0] = registryTransporter(7, { nama_transporter: "PT Angkut Tujuh Jaya" });
    expect(await sync()).toMatchObject({ transporters: 1 });
    expect((await partnerRows()).map((row) => row.name)).toEqual(["Dari Odoo", "PT Angkut Tujuh Jaya", "Transporter 8"]);
  });
});

describe("syncVcf: runs", () => {
  it("writes nothing new on a second run except the time the registry was read", async () => {
    const { database, sync, clock, vcf } = await setup({
      drivers: [registryDriver(1), registryDriver(2, { status: "warning" })],
      transporters: [registryTransporter(7)],
    });
    const snapshot = async () => ({
      drivers: await database.query("select id, full_name, licence_no, licence_class, licence_valid_until, registry_ref, registry_status, registry_push, is_active, updated_at from drivers order by id"),
      partners: await database.query("select * from partners order by id"),
    });
    expect(await sync()).toMatchObject({ drivers: 2, transporters: 1, skipped: 0 });
    const before = await snapshot();

    clock.advance(3_600_000);
    expect(await sync()).toMatchObject({ drivers: 0, transporters: 0, skipped: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await database.query("select distinct registry_synced_at from drivers")).toEqual([{ registry_synced_at: clock.now() }]);

    expect(await runs(database)).toEqual([
      { erp_system: "VCF", entity: "DRIVER", status: "OK", rows_upserted: 2, error: null, finished: true },
      { erp_system: "VCF", entity: "PARTNER", status: "OK", rows_upserted: 1, error: null, finished: true },
      { erp_system: "VCF", entity: "DRIVER", status: "OK", rows_upserted: 0, error: null, finished: true },
      { erp_system: "VCF", entity: "PARTNER", status: "OK", rows_upserted: 0, error: null, finished: true },
    ]);
    // four runs of two GET requests each would be eight; two runs made four, and nothing else was asked
    expect(vcf.requests).toEqual([
      { method: "GET", url: "/api/master/drivers" },
      { method: "GET", url: "/api/master/transporters" },
      { method: "GET", url: "/api/master/drivers" },
      { method: "GET", url: "/api/master/transporters" },
    ]);
  });

  it("records a failure on both runs and writes no rows", async () => {
    const { database, sync, vcf } = await setup({ drivers: [registryDriver(1)], transporters: [registryTransporter(7)] });
    vcf.failWith(502, "/api/master/transporters");
    await expect(sync()).rejects.toThrow(/HTTP 502/);
    expect(await database.query("select count(*)::int as n from drivers")).toEqual([{ n: 0 }]);
    expect(await database.query("select count(*)::int as n from partners")).toEqual([{ n: 0 }]);
    const failed = { status: "FAILED", rows_upserted: 0, error: "The driver registry answered HTTP 502 for /api/master/transporters", finished: true };
    expect(await runs(database)).toEqual([
      { erp_system: "VCF", entity: "DRIVER", ...failed },
      { erp_system: "VCF", entity: "PARTNER", ...failed },
    ]);

    vcf.recover();
    expect(await sync()).toMatchObject({ drivers: 1, transporters: 1 });
  });
});
