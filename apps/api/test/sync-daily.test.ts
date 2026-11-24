// The daily pull at SYNC_DAILY_AT: when it runs, both pulls in order, a failure of the first not blocking the second,
// and the lock it shares with the web buttons.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DailySyncReport, nextDailyRun, runDailySync, scheduleDailySync } from "../src/sync/daily.js";
import { SyncLock } from "../src/sync/lock.js";
import { vcfClientFor } from "../src/vcf/client.js";
import { testApp } from "./helpers/app.js";
import { sampleOdooRecords, startFakeOdoo } from "./helpers/fake-odoo.js";
import { registryDriver, registryTransporter, startFakeVcf } from "./helpers/fake-vcf.js";
import { bearer, LOGISTICS, seedStaff } from "./helpers/users.js";

const DAY_MS = 86_400_000;

describe("nextDailyRun", () => {
  it("is later today at the plant when the time has not come yet", () => {
    // 17:00 in Jakarta
    expect(nextDailyRun(new Date("2026-11-24T10:00:00Z"), "18:15")).toEqual(new Date("2026-11-24T11:15:00Z"));
  });

  it("is tomorrow when the time has passed today, or is now", () => {
    // 19:00 in Jakarta
    expect(nextDailyRun(new Date("2026-11-24T12:00:00Z"), "18:15")).toEqual(new Date("2026-11-25T11:15:00Z"));
    expect(nextDailyRun(new Date("2026-11-24T11:15:00Z"), "18:15")).toEqual(new Date("2026-11-25T11:15:00Z"));
  });

  it("counts the day at the plant, not in UTC, across midnight", () => {
    // 00:30 on the 25th in Jakarta, still the 24th in UTC
    expect(nextDailyRun(new Date("2026-11-24T17:30:00Z"), "00:15")).toEqual(new Date("2026-11-25T17:15:00Z"));
    expect(nextDailyRun(new Date("2026-11-24T17:30:00Z"), "00:45")).toEqual(new Date("2026-11-24T17:45:00Z"));
    // 23:55 on the 24th in Jakarta
    expect(nextDailyRun(new Date("2026-11-24T16:55:00Z"), "23:50")).toEqual(new Date("2026-11-25T16:50:00Z"));
    expect(nextDailyRun(new Date("2026-11-24T16:55:00Z"), "00:10")).toEqual(new Date("2026-11-24T17:10:00Z"));
  });
});

describe("scheduleDailySync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules nothing when no time is set", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-11-24T10:00:00Z") });
    const run = vi.fn(async () => {});
    expect(scheduleDailySync(null, () => new Date(), run, { error: vi.fn() })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs at the time each day until it is stopped, also after a run that threw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-11-24T10:00:00Z") });
    const run = vi.fn(async () => {});
    run.mockRejectedValueOnce(new Error("boom"));
    const error = vi.fn();
    const stop = scheduleDailySync("18:15", () => new Date(), run, { error });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(75 * 60_000 - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(run).toHaveBeenCalledTimes(2);
    stop?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("runDailySync", () => {
  async function setup(options: { odoo?: boolean; vcf?: boolean } = {}) {
    const odoo = await startFakeOdoo(sampleOdooRecords());
    const vcf = await startFakeVcf({ drivers: [registryDriver(1)], transporters: [registryTransporter(7)] });
    const syncLock = new SyncLock();
    const context = await testApp({ ...(options.odoo === false ? {} : odoo.env), ...(options.vcf === false ? {} : { VCF_URL: vcf.url }) }, { syncLock });
    await seedStaff(context.database, "logistics", { ...LOGISTICS });
    const daily = { config: context.config, database: context.database, now: context.clock.now, vcf: vcfClientFor(context.config.vcf), syncLock };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runs = () => context.database.query<{ erp_system: string; entity: string; status: string }>("select erp_system, entity, status from erp_sync_runs order by id");
    return { ...context, odoo, vcf, syncLock, daily, log, runs };
  }

  it("pulls Odoo in full mode and then VCF", async () => {
    const { daily, log, runs, database, odoo } = await setup();
    const report = await runDailySync(daily, log);
    expect(report.odoo).toMatchObject({ status: "OK", result: { contracts: 8 } });
    expect(report.vcf).toMatchObject({ status: "OK", result: { drivers: 1, transporters: 1 } });
    expect(await runs()).toEqual([
      { erp_system: "ODOO", entity: "CONTRACT", status: "OK" },
      { erp_system: "VCF", entity: "DRIVER", status: "OK" },
      { erp_system: "VCF", entity: "PARTNER", status: "OK" },
    ]);
    // only a full run records when it ran, and it asks Odoo for every contract header
    expect(await database.query("select count(*)::int as n from settings where key = 'odoo_full_sync'")).toEqual([{ n: 1 }]);
    expect(odoo.calls.find((call) => call.model === "sale.blanket.order")?.domain).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("still pulls VCF when Odoo fails, and records the failure", async () => {
    const { daily, log, runs, odoo } = await setup();
    odoo.failWith("database is starting up");
    const report = await runDailySync(daily, log);
    expect(report.odoo).toMatchObject({ status: "FAILED", error: expect.stringContaining("database is starting up") });
    expect(report.vcf.status).toBe("OK");
    expect(await runs()).toEqual([
      { erp_system: "ODOO", entity: "CONTRACT", status: "FAILED" },
      { erp_system: "VCF", entity: "DRIVER", status: "OK" },
      { erp_system: "VCF", entity: "PARTNER", status: "OK" },
    ]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("skips a pull that is not configured", async () => {
    const { daily, log, runs } = await setup({ odoo: false, vcf: false });
    expect(await runDailySync(daily, log)).toEqual<DailySyncReport>({
      odoo: { status: "SKIPPED", reason: "NOT_CONFIGURED" },
      vcf: { status: "SKIPPED", reason: "NOT_CONFIGURED" },
    });
    expect(await runs()).toEqual([]);
  });

  it("skips the Odoo pull a web button started, and goes on with VCF", async () => {
    const { app, daily, log, odoo, runs } = await setup();
    const headers = await bearer(app, "logistics");
    const release = odoo.hold();
    const pressed = app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers });
    await vi.waitFor(() => expect(odoo.calls.length).toBe(1));

    const report = await runDailySync(daily, log);
    expect(report.odoo).toEqual({ status: "SKIPPED", reason: "RUNNING" });
    expect(report.vcf.status).toBe("OK");
    release();
    expect((await pressed).statusCode).toBe(200);
    expect((await runs()).filter((run) => run.erp_system === "ODOO")).toHaveLength(1);
  });

  it("makes a web button answer 409 SYNC_RUNNING while the daily pull runs, and frees it afterwards", async () => {
    const { app, daily, log, odoo, vcf } = await setup();
    const headers = await bearer(app, "logistics");
    const releaseOdoo = odoo.hold();
    const releaseVcf = vcf.hold();
    const running = runDailySync(daily, log);
    await vi.waitFor(() => expect(odoo.calls.length).toBe(1));

    const odooButton = await app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers });
    expect(odooButton.statusCode).toBe(409);
    expect(odooButton.json()).toEqual({ error: { code: "SYNC_RUNNING", message: "Sinkronisasi Odoo sedang berjalan." } });
    releaseOdoo();
    await vi.waitFor(() => expect(vcf.requests.length).toBeGreaterThan(0));
    const vcfButton = await app.inject({ method: "POST", url: "/api/admin/sync/vcf", headers });
    expect(vcfButton.statusCode).toBe(409);
    expect(vcfButton.json()).toEqual({ error: { code: "SYNC_RUNNING", message: "Sinkronisasi master supir sedang berjalan." } });
    releaseVcf();

    expect((await running).vcf.status).toBe("OK");
    expect((await app.inject({ method: "POST", url: "/api/admin/sync/odoo", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/admin/sync/vcf", headers })).statusCode).toBe(200);
  });
});
