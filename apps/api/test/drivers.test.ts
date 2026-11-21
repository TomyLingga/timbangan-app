import { describe, expect, it, vi } from "vitest";
import { runSyncVcf } from "../src/cli/sync-vcf.js";
import { freshDatabase, TEST_JWT_SECRET, testApp } from "./helpers/app.js";
import { registryDriver, registryTransporter, startFakeVcf } from "./helpers/fake-vcf.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

async function setup(env: Record<string, string> = {}) {
  const context = await testApp(env);
  const { app, database } = context;
  const adminId = await seedStaff(database, "logistics", "LOGISTICS_ADMIN");
  await seedStaff(database, "qc", "QC_OPERATOR");
  await seedStaff(database, "pos", "REGISTRATION_OPERATOR");
  await seedPartnerUser(database, "angkut", await seedPartner(database, "PT Angkut Satu"), "PARTNER_TRANSPORTER");
  const as = async (username: string) => bearer(app, username);
  const call = async (method: "GET" | "POST", url: string, username: string | null = "logistics", payload?: object) =>
    app.inject({ method, url, headers: username ? await as(username) : {}, ...(payload ? { payload } : {}) });
  return { ...context, adminId, call };
}

describe("POST /api/admin/sync/vcf", () => {
  it("copies the registry and answers the counts, for logistics admins and system admins", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1), registryDriver(2, { no_sim: "x" })], transporters: [registryTransporter(7)] });
    const { call, database } = await setup({ VCF_URL: vcf.url });
    const response = await call("POST", "/api/admin/sync/vcf");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ drivers: 1, transporters: 1, skipped: 1, pushed: 0, pushFailed: 0, durationMs: expect.any(Number) });
    expect(await database.query("select count(*)::int as n from drivers")).toEqual([{ n: 1 }]);

    vcf.requests.length = 0;
    expect((await call("POST", "/api/admin/sync/vcf", "qc")).statusCode).toBe(403);
    expect((await call("POST", "/api/admin/sync/vcf", "angkut")).statusCode).toBe(403);
    expect((await call("POST", "/api/admin/sync/vcf", null)).statusCode).toBe(401);
    expect(vcf.requests).toEqual([]);
  });

  it("answers 503 NOT_CONFIGURED without VCF_URL", async () => {
    const { call } = await setup();
    const response = await call("POST", "/api/admin/sync/vcf");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "NOT_CONFIGURED", message: "Master supir pusat belum diatur di server." } });
  });

  it("answers 409 SYNC_RUNNING while a run is going, and 502 SYNC_FAILED when the registry fails", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)] });
    const { app, call } = await setup({ VCF_URL: vcf.url });
    const headers = await bearer(app, "logistics");
    const release = vcf.hold();
    const first = app.inject({ method: "POST", url: "/api/admin/sync/vcf", headers });
    await vi.waitFor(() => expect(vcf.requests.length).toBe(1));
    const second = await app.inject({ method: "POST", url: "/api/admin/sync/vcf", headers });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: { code: "SYNC_RUNNING", message: "Sinkronisasi master supir sedang berjalan." } });
    release();
    expect((await first).statusCode).toBe(200);

    vcf.failWith(500);
    const failed = await call("POST", "/api/admin/sync/vcf");
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: { code: "SYNC_FAILED", message: "Sinkronisasi master supir gagal. Lihat riwayat sinkronisasi." } });
  });
});

describe("sync:vcf command", () => {
  const base = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };

  it("runs the sync and prints the counts; without VCF_URL it explains and exits with 1", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)], transporters: [registryTransporter(7), registryTransporter(8)] });
    const database = await freshDatabase();
    const open = async () => ({ ...database, close: async () => {} });
    const lines: string[] = [];
    expect(await runSyncVcf({ ...base, VCF_URL: vcf.url }, (line) => lines.push(line), open)).toBe(0);
    expect(lines.join("\n")).toMatch(/^Driver registry sync finished in \d+ ms: 1 drivers, 2 transporters written; 0 rows skipped; 0 drivers sent to the registry, 0 failed\.$/);

    lines.length = 0;
    expect(await runSyncVcf(base, (line) => lines.push(line), open)).toBe(1);
    expect(lines.join("\n")).toContain("VCF_URL");
  });
});

describe("GET /api/drivers", () => {
  async function withDrivers() {
    const context = await setup();
    await context.database.script(`
      insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_ref, registry_status, registry_synced_at)
        values ('Agus Wibowo', 'AB12345678', 'B2 UMUM', '2026-11-19', '1', 'WARNING', '2026-11-20T01:00:00Z'),
               ('Bambang', 'CD00001111', 'B1', '2026-11-20', '2', 'BLACKLIST', '2026-11-20T01:00:00Z'),
               ('Cahya', 'EF99990000', null, null, '3', 'NORMAL', '2026-11-20T01:00:00Z');
      insert into drivers (full_name, licence_no, is_active) values ('Dedi Lokal', 'GH55556666', false);
    `);
    const names = async (query: string) => (await context.call("GET", `/api/drivers${query}`)).json().items.map((item: { fullName: string }) => item.fullName);
    return { ...context, names };
  }

  it("lists drivers with their registry status and whether the licence has expired today", async () => {
    const { call } = await withDrivers();
    const response = await call("GET", "/api/drivers", "qc");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(4);
    expect(body.items[0]).toEqual({
      id: expect.any(Number),
      fullName: "Agus Wibowo",
      licenceNo: "AB12345678",
      licenceClass: "B2 UMUM",
      licenceValidUntil: "2026-11-19",
      // the test clock stands on 20 November in Jakarta
      licenceExpired: true,
      registryStatus: "WARNING",
      registrySyncedAt: "2026-11-20T01:00:00.000Z",
      registryPush: "NONE",
      registryPushError: null,
      isActive: true,
    });
    expect(body.items.map((item: { fullName: string; licenceExpired: boolean }) => [item.fullName, item.licenceExpired])).toEqual([
      ["Agus Wibowo", true],
      ["Bambang", false],
      ["Cahya", false],
      ["Dedi Lokal", false],
    ]);
    expect(body.items[3]).toMatchObject({ registryStatus: "UNKNOWN", registrySyncedAt: null, isActive: false, licenceValidUntil: null });
  });

  it("filters by name or licence number, by status, and applies the limit", async () => {
    const { names, call } = await withDrivers();
    expect(await names("?q=wib")).toEqual(["Agus Wibowo"]);
    expect(await names("?q=cd-0000%201")).toEqual(["Bambang"]);
    expect(await names("?q=9999")).toEqual(["Cahya"]);
    expect(await names("?status=BLACKLIST")).toEqual(["Bambang"]);
    expect(await names("?status=UNKNOWN")).toEqual(["Dedi Lokal"]);
    expect(await names("?status=NORMAL&q=agus")).toEqual([]);
    const limited = (await call("GET", "/api/drivers?limit=2")).json();
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(4);

    const invalid = await call("GET", "/api/drivers?status=banned");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields).toEqual([{ field: "status", message: "Status harus NORMAL, WARNING, BLACKLIST, atau UNKNOWN." }]);
  });

  it("shows the state of sending to the registry and filters by it", async () => {
    const { call, database, names } = await withDrivers();
    await database.script(`
      insert into drivers (full_name, licence_no, registry_push) values ('Eko Antre', 'JK00000001', 'PENDING');
      insert into drivers (full_name, licence_no, registry_push, registry_push_error) values ('Fajar Gagal', 'JK00000002', 'FAILED', 'VCF menjawab HTTP 503.');
      insert into drivers (full_name, licence_no, registry_ref, registry_status, registry_push) values ('Gilang Terkirim', 'JK00000003', '1001', 'NORMAL', 'SENT');
    `);
    const failed = (await call("GET", "/api/drivers?push=FAILED")).json();
    expect(failed.total).toBe(1);
    expect(failed.items[0]).toMatchObject({ fullName: "Fajar Gagal", registryPush: "FAILED", registryPushError: "VCF menjawab HTTP 503." });
    expect(await names("?push=PENDING")).toEqual(["Eko Antre"]);
    expect(await names("?push=SENT")).toEqual(["Gilang Terkirim"]);
    expect(await names("?push=NONE")).toEqual(["Agus Wibowo", "Bambang", "Cahya", "Dedi Lokal"]);
    expect(await names("?push=PENDING&q=fajar")).toEqual([]);

    const invalid = await call("GET", "/api/drivers?push=DONE");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields).toEqual([{ field: "push", message: "Status kirim harus NONE, PENDING, SENT, atau FAILED." }]);
  });

  it("is for staff with a role: partner accounts and staff without a role get 403", async () => {
    const { call, database } = await withDrivers();
    expect((await call("GET", "/api/drivers", null)).statusCode).toBe(401);
    const partner = await call("GET", "/api/drivers", "angkut");
    expect(partner.statusCode).toBe(403);
    expect(partner.json().error.code).toBe("FORBIDDEN");
    await database.query("delete from user_roles where user_id = (select id from users where username = 'qc')");
    expect((await call("GET", "/api/drivers", "qc")).json().error.code).toBe("NO_ROLE");
  });
});

describe("POST /api/drivers", () => {
  const body = { fullName: "  Eko Prasetyo ", licenceNo: "jk-1234 5678", licenceClass: "B2 UMUM", licenceValidUntil: "2029-02-28", phone: "0800000000" };

  it("creates a local driver that waits to be sent to the registry", async () => {
    const { call, database, adminId } = await setup();
    const response = await call("POST", "/api/drivers", "logistics", body);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      driver: {
        id: expect.any(Number),
        fullName: "Eko Prasetyo",
        licenceNo: "JK12345678",
        licenceClass: "B2 UMUM",
        licenceValidUntil: "2029-02-28",
        licenceExpired: false,
        registryStatus: "UNKNOWN",
        registrySyncedAt: null,
        registryPush: "PENDING",
        registryPushError: null,
        isActive: true,
      },
    });
    expect(await database.query("select phone, registry_push, registry_ref, created_by::int as created_by from drivers")).toEqual([
      { phone: "0800000000", registry_push: "PENDING", registry_ref: null, created_by: adminId },
    ]);
    expect((await call("POST", "/api/drivers", "pos", { ...body, licenceNo: "ZZ00001111", phone: undefined })).statusCode).toBe(201);
  });

  it("answers 409 DUPLICATE for a licence number that exists, however it is written", async () => {
    const { call, database } = await setup();
    await call("POST", "/api/drivers", "logistics", body);
    const again = await call("POST", "/api/drivers", "logistics", { ...body, fullName: "Orang Lain", licenceNo: "JK 1234-5678" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: "DUPLICATE", message: "Nomor SIM JK12345678 sudah terdaftar." } });
    expect(await database.query("select count(*)::int as n from drivers")).toEqual([{ n: 1 }]);
  });

  it("answers 400 VALIDATION for missing or malformed fields", async () => {
    const { call } = await setup();
    const empty = await call("POST", "/api/drivers", "logistics", {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.fields).toEqual([
      { field: "fullName", message: "Nama supir wajib diisi." },
      { field: "licenceNo", message: "Nomor SIM wajib diisi." },
      { field: "licenceClass", message: "Jenis SIM wajib diisi." },
      { field: "licenceValidUntil", message: "Masa berlaku SIM harus berformat YYYY-MM-DD." },
    ]);
    const malformed = await call("POST", "/api/drivers", "logistics", { ...body, licenceNo: "12-3", licenceValidUntil: "28/02/2029" });
    expect(malformed.json().error.fields).toEqual([
      { field: "licenceNo", message: "Nomor SIM harus 6 sampai 20 huruf atau angka." },
      { field: "licenceValidUntil", message: "Masa berlaku SIM harus berformat YYYY-MM-DD." },
    ]);
  });

  it("is for system admins, logistics admins and registration operators", async () => {
    const { call, database } = await setup();
    expect((await call("POST", "/api/drivers", "qc", body)).statusCode).toBe(403);
    expect((await call("POST", "/api/drivers", "angkut", body)).statusCode).toBe(403);
    expect((await call("POST", "/api/drivers", null, body)).statusCode).toBe(401);
    expect(await database.query("select count(*)::int as n from drivers")).toEqual([{ n: 0 }]);
  });
});
