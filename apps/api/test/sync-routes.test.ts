import { describe, expect, it, vi } from "vitest";
import { runSyncOdoo } from "../src/cli/sync-odoo.js";
import { freshDatabase, TEST_JWT_SECRET, testApp } from "./helpers/app.js";
import { sampleOdooRecords, startFakeOdoo } from "./helpers/fake-odoo.js";
import { bearer, EVERYTHING, LOGISTICS, seedPartner, seedPartnerUser, seedStaff, SUPPLIER, VIEWER } from "./helpers/users.js";

async function withOdoo() {
  const odoo = await startFakeOdoo(sampleOdooRecords());
  const context = await testApp(odoo.env);
  await seedStaff(context.database, "logistics", LOGISTICS);
  const post = async (username?: string) =>
    context.app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers: username ? await bearer(context.app, username) : {} });
  return { ...context, odoo, post };
}

describe("POST /api/admin/sync/odoo", () => {
  it("runs the sync for a logistics admin and answers the counts", async () => {
    const { post, database } = await withOdoo();
    const response = await post("logistics");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ contracts: 8, partners: 2, products: 3, skipped: 3, tanks: { status: "SKIPPED", reason: "Lokasi induk tangki di Odoo belum diatur (ODOO_TANK_PARENT_LOCATION_ID); tangki tidak disinkronkan." }, durationMs: expect.any(Number) });
    expect(await database.query("select count(*)::int as n from erp_contracts")).toEqual([{ n: 8 }]);

    expect((await post("logistics")).json()).toMatchObject({ contracts: 0, partners: 0, products: 0, skipped: 0 });
  });

  it("also copies the tanks when the parent location is configured", async () => {
    const odoo = await startFakeOdoo(sampleOdooRecords());
    const context = await testApp({ ...odoo.env, ODOO_TANK_PARENT_LOCATION_ID: "40" });
    await seedStaff(context.database, "logistics", LOGISTICS);
    const response = await context.app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers: await bearer(context.app, "logistics") });
    expect(response.statusCode).toBe(200);
    expect(response.json().tanks).toEqual({ status: "OK", written: 4, deactivated: 0, skipped: 0 });
    expect(await context.database.query("select entity, status from erp_sync_runs order by id")).toEqual([
      { entity: "CONTRACT", status: "OK" },
      { entity: "TANK", status: "OK" },
    ]);
  });

  it("is open to staff with contracts:EDIT only", async () => {
    const { post, database, odoo } = await withOdoo();
    await seedStaff(database, "root", EVERYTHING);
    await seedStaff(database, "supervisor", VIEWER);
    await seedPartnerUser(database, "pks-a", await seedPartner(database, "PKS A"), SUPPLIER);

    expect((await post()).statusCode).toBe(401);
    expect((await post("supervisor")).statusCode).toBe(403);
    expect((await post("pks-a")).statusCode).toBe(403);
    expect(odoo.calls).toEqual([]);
    expect((await post("root")).statusCode).toBe(200);
  });

  it("answers 503 NOT_CONFIGURED when the Odoo settings are incomplete", async () => {
    const { app, database } = await testApp({ ODOO_URL: "http://127.0.0.1:1", ODOO_DB: "live_test" });
    await seedStaff(database, "logistics", LOGISTICS);
    const response = await app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers: await bearer(app, "logistics") });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "NOT_CONFIGURED", message: "Odoo belum diatur di server." } });
  });

  it("answers 409 SYNC_RUNNING to a second request while one is running", async () => {
    const { app, odoo } = await withOdoo();
    const headers = await bearer(app, "logistics");
    const release = odoo.hold();
    const first = app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers });
    await vi.waitFor(() => expect(odoo.calls.length).toBe(1));

    const second = await app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: { code: "SYNC_RUNNING", message: "Sinkronisasi Odoo sedang berjalan." } });

    release();
    expect((await first).statusCode).toBe(200);
    // once it has finished, the next request runs again
    expect((await app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers })).statusCode).toBe(200);
  });

  it("answers 502 SYNC_FAILED when Odoo fails, and can run again afterwards", async () => {
    const { post, odoo } = await withOdoo();
    odoo.failWith("database is starting up");
    const response = await post("logistics");
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: { code: "SYNC_FAILED", message: "Sinkronisasi Odoo gagal. Lihat riwayat sinkronisasi." } });

    odoo.recover();
    expect((await post("logistics")).statusCode).toBe(200);
  });
});

describe("GET /api/admin/sync/runs", () => {
  it("lists the runs, newest first, up to the limit", async () => {
    const { app, post, odoo, clock } = await withOdoo();
    await post("logistics");
    clock.advance(60_000);
    odoo.failWith("database is starting up");
    await post("logistics");
    const headers = await bearer(app, "logistics");

    const response = await app.inject({ method: "GET", url: "/api/admin/sync/runs", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: expect.any(Number),
          erpSystem: "ODOO",
          entity: "CONTRACT",
          startedAt: "2026-11-20T03:01:00.000Z",
          finishedAt: "2026-11-20T03:01:00.000Z",
          status: "FAILED",
          cursorValue: null,
          rowsUpserted: 0,
          error: "Odoo error for purchase.requisition: database is starting up",
        },
        {
          id: expect.any(Number),
          erpSystem: "ODOO",
          entity: "CONTRACT",
          startedAt: "2026-11-20T03:00:00.000Z",
          finishedAt: "2026-11-20T03:00:00.000Z",
          status: "OK",
          cursorValue: "2026-11-11 03:00:04",
          rowsUpserted: 8,
          error: null,
        },
      ],
    });

    const limited = await app.inject({ method: "GET", url: "/api/admin/sync/runs?limit=1", headers });
    expect(limited.json().items.map((item: { status: string }) => item.status)).toEqual(["FAILED"]);
  });

  it("validates the limit and needs contracts:VIEW or drivers:VIEW", async () => {
    const { app, database } = await withOdoo();
    await seedStaff(database, "desk", { gate: "EDIT" });
    await seedStaff(database, "drivers", { drivers: "VIEW" });
    const headers = await bearer(app, "logistics");

    const invalid = await app.inject({ method: "GET", url: "/api/admin/sync/runs?limit=0", headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: "VALIDATION", fields: [{ field: "limit", message: "Limit harus antara 1 dan 100." }] });
    expect((await app.inject({ method: "GET", url: "/api/admin/sync/runs?limit=abc", headers })).statusCode).toBe(400);

    expect((await app.inject({ method: "GET", url: "/api/admin/sync/runs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/sync/runs", headers: await bearer(app, "desk") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/sync/runs", headers: await bearer(app, "drivers") })).statusCode).toBe(200);
  });
});

describe("sync:odoo command", () => {
  const base = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };

  it("runs the sync and prints the counts", async () => {
    const odoo = await startFakeOdoo(sampleOdooRecords());
    const database = await freshDatabase();
    const lines: string[] = [];
    const code = await runSyncOdoo({ ...base, ...odoo.env }, (line) => lines.push(line), async () => ({ ...database, close: async () => {} }));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(
      /^Odoo sync finished in \d+ ms: 8 contracts, 2 partners, 3 products written; 3 lines skipped\.\nTanks skipped: ODOO_TANK_PARENT_LOCATION_ID is not set\.$/,
    );
    expect(await database.query("select status from erp_sync_runs")).toEqual([{ status: "OK" }]);

    lines.length = 0;
    const withTanks = { ...base, ...odoo.env, ODOO_TANK_PARENT_LOCATION_ID: "40" };
    expect(await runSyncOdoo(withTanks, (line) => lines.push(line), async () => ({ ...database, close: async () => {} }))).toBe(0);
    expect(lines[1]).toBe("Tanks: 4 written, 0 made inactive, 0 skipped.");
  });

  it("explains missing settings and a failed run, and exits with 1", async () => {
    const database = await freshDatabase();
    const open = async () => ({ ...database, close: async () => {} });
    const lines: string[] = [];
    expect(await runSyncOdoo(base, (line) => lines.push(line), open)).toBe(1);
    expect(lines.join("\n")).toContain("ODOO_URL, ODOO_DB, ODOO_UID and ODOO_PASSWORD");

    const odoo = await startFakeOdoo();
    odoo.failWith("database is starting up");
    lines.length = 0;
    expect(await runSyncOdoo({ ...base, ...odoo.env }, (line) => lines.push(line), open)).toBe(1);
    expect(lines.join("\n")).toContain("database is starting up");
    expect(lines.join("\n")).not.toContain("odoo-secret");
  });
});
