import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AppOptions } from "../src/app.js";
import { runSyncVcf } from "../src/cli/sync-vcf.js";
import { freshDatabase, TEST_JWT_SECRET, testApp } from "./helpers/app.js";
import { FAKE_ACCOUNT, registryDriver, registryTransporter, startFakeVcf } from "./helpers/fake-vcf.js";
import { bearer, seedStaff } from "./helpers/users.js";

const accountEnv = (url: string, account = FAKE_ACCOUNT) => ({ VCF_URL: url, VCF_USERNAME: account.username, VCF_PASSWORD: account.password });
const body = { fullName: "Eko Prasetyo", licenceNo: "JK12345678", licenceClass: "B2 UMUM", licenceValidUntil: "2029-02-28" };
const ALLOWED_CALLS = new Set(["POST /api/login", "POST /api/master/driver", "GET /api/master/drivers", "GET /api/master/transporters"]);

async function setup(env: Record<string, string>, options: Partial<AppOptions> = {}) {
  const context = await testApp(env, options);
  await seedStaff(context.database, "logistics", "LOGISTICS_ADMIN");
  const headers = await bearer(context.app, "logistics");
  const createDriver = (payload: object = body) => context.app.inject({ method: "POST", url: "/api/drivers", headers, payload });
  const sync = () => context.app.inject({ method: "POST", url: "/api/admin/sync/vcf", headers });
  const pushState = () => context.database.query("select licence_no, registry_ref, registry_push, registry_push_error from drivers order by licence_no");
  return { ...context, createDriver, sync, pushState };
}

describe("POST /api/drivers: sending the new driver at once", () => {
  it("sends the driver and answers it with the registry id's status and SENT", async () => {
    const vcf = await startFakeVcf();
    const { createDriver, pushState, clock } = await setup(accountEnv(vcf.url));
    const response = await createDriver();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      driver: {
        id: expect.any(Number),
        fullName: "Eko Prasetyo",
        licenceNo: "JK12345678",
        licenceClass: "B2 UMUM",
        licenceValidUntil: "2029-02-28",
        licenceExpired: false,
        registryStatus: "NORMAL",
        registrySyncedAt: clock.now().toISOString(),
        registryPush: "SENT",
        registryPushError: null,
        isActive: true,
      },
    });
    expect(await pushState()).toEqual([{ licence_no: "JK12345678", registry_ref: "1001", registry_push: "SENT", registry_push_error: null }]);
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver"]);
  });

  it("does not fail the request when the registry refuses the driver or the account", async () => {
    const vcf = await startFakeVcf();
    const { createDriver } = await setup(accountEnv(vcf.url));
    vcf.failOnce("/api/master/driver", 500);
    const failed = await createDriver();
    expect(failed.statusCode).toBe(201);
    expect(failed.json().driver).toMatchObject({ registryPush: "FAILED", registryPushError: "VCF menjawab HTTP 500.", registryStatus: "UNKNOWN" });

    vcf.setRole("operator");
    const forbidden = await createDriver({ ...body, licenceNo: "JK00000002" });
    expect(forbidden.statusCode).toBe(201);
    expect(forbidden.json()).toMatchObject({ driver: { registryPush: "FAILED", registryPushError: "Akun VCF tidak berhak menambah supir." }, pushStopped: "Akun VCF tidak berhak menambah supir." });
  });

  it("leaves the driver PENDING when the credentials are wrong", async () => {
    const vcf = await startFakeVcf();
    const { createDriver } = await setup(accountEnv(vcf.url, { username: FAKE_ACCOUNT.username, password: "wrong-password-42" }));
    const response = await createDriver();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ driver: { registryPush: "PENDING", registryPushError: null }, pushStopped: "Login VCF ditolak: username atau password salah." });
  });

  it("answers within the limit when the registry is slow, and the driver waits for the next run", async () => {
    const vcf = await startFakeVcf();
    const { createDriver, pushState } = await setup(accountEnv(vcf.url), { registryPushTimeoutMs: 300 });
    // the first driver logs in; then the registry stops answering
    expect((await createDriver()).json().driver.registryPush).toBe("SENT");
    const release = vcf.hold();
    try {
      const started = performance.now();
      const response = await createDriver({ ...body, licenceNo: "JK00000002" });
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(response.statusCode).toBe(201);
      expect(response.json().driver).toMatchObject({ registryPush: "FAILED", registryPushError: "VCF tidak menjawab dalam batas waktu." });
    } finally {
      release();
    }
    expect((await pushState()).map((row) => [row.licence_no, row.registry_push])).toEqual([
      ["JK00000002", "FAILED"],
      ["JK12345678", "SENT"],
    ]);
  });

  it("stays PENDING when the login itself does not answer in time", async () => {
    const vcf = await startFakeVcf();
    const { createDriver } = await setup(accountEnv(vcf.url), { registryPushTimeoutMs: 300 });
    const release = vcf.hold();
    try {
      const response = await createDriver();
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ driver: { registryPush: "PENDING" }, pushStopped: "Login VCF gagal: VCF tidak menjawab dalam batas waktu." });
    } finally {
      release();
    }
  });

  it("sends nothing when no account is configured", async () => {
    const vcf = await startFakeVcf();
    const { createDriver } = await setup({ VCF_URL: vcf.url, VCF_USERNAME: FAKE_ACCOUNT.username });
    const response = await createDriver();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ driver: expect.objectContaining({ registryPush: "PENDING", registryPushError: null }) });
    expect(vcf.calls).toEqual([]);
  });

  it("uses a limit of 5 seconds unless told otherwise", async () => {
    const { DEFAULT_REGISTRY_PUSH_TIMEOUT_MS } = await import("../src/app.js");
    expect(DEFAULT_REGISTRY_PUSH_TIMEOUT_MS).toBe(5_000);
  });
});

describe("POST /api/admin/sync/vcf: sending first", () => {
  it("sends pending drivers, then reads the lists, and answers both counts", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)], transporters: [registryTransporter(7)] });
    const { sync, database, pushState } = await setup(accountEnv(vcf.url));
    await database.script(`
      insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_push, created_at) values
        ('Lokal Satu', 'LOC0000001', 'B2 UMUM', '2029-01-31', 'PENDING', '2026-11-01T00:00:00Z'),
        ('Lokal Dua', 'LOC0000002', 'B1', '2029-01-31', 'FAILED', '2026-11-01T00:01:00Z'),
        ('Tanpa Jenis', 'LOC0000003', null, '2029-01-31', 'PENDING', '2026-11-01T00:02:00Z');
    `);
    const response = await sync();
    expect(response.statusCode).toBe(200);
    // the two drivers sent come back in the list unchanged; only registry driver 1 is new here
    expect(response.json()).toEqual({ drivers: 1, transporters: 1, skipped: 0, pushed: 2, pushFailed: 1, durationMs: expect.any(Number) });
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver", "POST /api/master/driver", "GET /api/master/drivers", "GET /api/master/transporters"]);
    expect(await pushState()).toEqual([
      { licence_no: "990000000001", registry_ref: "1", registry_push: "NONE", registry_push_error: null },
      { licence_no: "LOC0000001", registry_ref: "1001", registry_push: "SENT", registry_push_error: null },
      { licence_no: "LOC0000002", registry_ref: "1002", registry_push: "SENT", registry_push_error: null },
      { licence_no: "LOC0000003", registry_ref: null, registry_push: "FAILED", registry_push_error: "Jenis SIM belum diisi." },
    ]);
  });

  it("reports why sending stopped and still reads the lists", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)] });
    const { sync, database, pushState } = await setup(accountEnv(vcf.url, { username: FAKE_ACCOUNT.username, password: "wrong-password-42" }));
    await database.script("insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_push) values ('Lokal', 'LOC0000001', 'B1', '2029-01-31', 'PENDING')");
    const response = await sync();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      drivers: 1,
      transporters: 0,
      skipped: 0,
      pushed: 0,
      pushFailed: 0,
      pushStopped: "Login VCF ditolak: username atau password salah.",
      durationMs: expect.any(Number),
    });
    expect((await pushState()).find((row) => row.licence_no === "LOC0000001")).toMatchObject({ registry_push: "PENDING" });
  });

  it("skips sending entirely without an account, and reading still works", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)] });
    const { sync, database, pushState } = await setup({ VCF_URL: vcf.url });
    await database.script("insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_push) values ('Lokal', 'LOC0000001', 'B1', '2029-01-31', 'PENDING')");
    const response = await sync();
    expect(response.json()).toEqual({ drivers: 1, transporters: 0, skipped: 0, pushed: 0, pushFailed: 0, durationMs: expect.any(Number) });
    expect(vcf.paths()).toEqual(["GET /api/master/drivers", "GET /api/master/transporters"]);
    expect((await pushState()).find((row) => row.licence_no === "LOC0000001")).toMatchObject({ registry_push: "PENDING" });
  });
});

describe("sync:vcf command: sending first", () => {
  it("prints the counts of sending and why it stopped", async () => {
    const vcf = await startFakeVcf();
    const database = await freshDatabase();
    const open = async () => ({ ...database, close: async () => {} });
    await database.script(`
      insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_push, created_at) values
        ('Lokal Satu', 'LOC0000001', 'B1', '2029-01-31', 'PENDING', '2026-11-01T00:00:00Z'),
        ('Lokal Dua', 'LOC0000002', 'B1', '2029-01-31', 'PENDING', '2026-11-01T00:01:00Z');
    `);
    vcf.failOnce("/api/master/driver", 503);
    const lines: string[] = [];
    const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, ...accountEnv(vcf.url) };
    expect(await runSyncVcf(env, (line) => lines.push(line), open)).toBe(0);
    expect(lines.join("\n")).toMatch(/: 0 drivers, 0 transporters written; 0 rows skipped; 1 drivers sent to the registry, 1 failed\.$/);

    await database.script("insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_push) values ('Lokal Tiga', 'LOC0000003', 'B1', '2029-01-31', 'PENDING')");
    vcf.setRole("operator");
    lines.length = 0;
    expect(await runSyncVcf(env, (line) => lines.push(line), open)).toBe(0);
    expect(lines.join("\n")).toContain("Sending stopped: Akun VCF tidak berhak menambah supir.");
    expect(lines.join("\n")).not.toContain(FAKE_ACCOUNT.password);
  });
});

describe("secrets and calls", () => {
  it("never writes the password or a token to the log, and asks the registry nothing else", async () => {
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)], transporters: [registryTransporter(7)] });
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { createDriver, sync, database } = await setup(accountEnv(vcf.url), { logger: { level: "trace", stream }, registryPushTimeoutMs: 300 });

    expect((await createDriver()).statusCode).toBe(201);
    // another login elsewhere: the next call logs in again
    vcf.invalidateTokens();
    expect((await createDriver({ ...body, licenceNo: "JK00000002" })).statusCode).toBe(201);
    vcf.failOnce("/api/master/driver", "drop");
    expect((await createDriver({ ...body, licenceNo: "JK00000003" })).statusCode).toBe(201);
    vcf.setRole("operator");
    expect((await createDriver({ ...body, licenceNo: "JK00000004" })).statusCode).toBe(201);
    vcf.setRole("admin");
    const release = vcf.hold();
    try {
      expect((await createDriver({ ...body, licenceNo: "JK00000005" })).statusCode).toBe(201);
    } finally {
      release();
    }
    expect((await sync()).statusCode).toBe(200);
    vcf.failWith(500, "/api/master/transporters");
    expect((await sync()).statusCode).toBe(502);

    expect(vcf.issuedTokens.length).toBeGreaterThanOrEqual(2);
    const output = lines.join("");
    const stored = JSON.stringify(await database.query("select * from drivers"));
    const runs = JSON.stringify(await database.query("select * from erp_sync_runs"));
    for (const secret of [FAKE_ACCOUNT.password, ...vcf.issuedTokens]) {
      expect(output).not.toContain(secret);
      expect(stored).not.toContain(secret);
      expect(runs).not.toContain(secret);
    }
    expect(output).toContain("sending the new driver to the registry stopped");
    expect(new Set(vcf.paths())).toEqual(ALLOWED_CALLS);
  });
});
