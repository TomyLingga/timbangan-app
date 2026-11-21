import { describe, expect, it } from "vitest";
import { VcfClient } from "../src/vcf/client.js";
import { pushPendingDrivers } from "../src/vcf/push.js";
import { freshDatabase, TestClock } from "./helpers/app.js";
import { FAKE_ACCOUNT, type RegistryRow, registryDriver, startFakeVcf } from "./helpers/fake-vcf.js";

type PushRow = {
  licence_no: string;
  registry_ref: string | null;
  registry_status: string;
  registry_push: string;
  registry_push_error: string | null;
  registry_synced_at: Date | null;
};

async function setup(options: { account?: { username: string; password: string } | null; drivers?: RegistryRow[] } = {}) {
  const database = await freshDatabase();
  const vcf = await startFakeVcf({ drivers: options.drivers ?? [] });
  const clock = new TestClock();
  const client = new VcfClient(vcf.url, options.account === undefined ? FAKE_ACCOUNT : options.account);
  const push = () => pushPendingDrivers(database, client, clock.now);
  const rows = () =>
    database.query<PushRow>("select licence_no, registry_ref, registry_status, registry_push, registry_push_error, registry_synced_at from drivers order by licence_no");
  const row = async (licence: string) => (await rows()).find((item) => item.licence_no === licence);
  /** A local driver; `minutes` sets created_at, so the order of sending can be checked. */
  const local = (licence: string, minutes: number, extra: { push?: string; error?: string; licenceClass?: string | null; validUntil?: string | null; ref?: string } = {}) =>
    database.query(
      `insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_ref, registry_push, registry_push_error, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        `Supir ${licence}`,
        licence,
        extra.licenceClass === undefined ? "B2 UMUM" : extra.licenceClass,
        extra.validUntil === undefined ? "2029-02-28" : extra.validUntil,
        extra.ref ?? null,
        extra.push ?? "PENDING",
        extra.error ?? null,
        new Date(Date.UTC(2026, 10, 1, 0, minutes)),
      ],
    );
  return { database, vcf, clock, client, push, rows, row, local };
}

const sent = (ref: string, status: string, at: Date) => ({ registry_ref: ref, registry_status: status, registry_push: "SENT", registry_push_error: null, registry_synced_at: at });

describe("pushPendingDrivers", () => {
  it("sends PENDING and FAILED drivers without a registry id, oldest first, and records the registry id and status", async () => {
    const { push, local, row, vcf, clock } = await setup();
    await local("NEW0000002", 2);
    await local("NEW0000001", 1, { push: "FAILED", error: "VCF tidak dapat dihubungi." });
    await local("NEW0000003", 3);
    await local("NOTQUEUED1", 0, { push: "NONE" });
    await local("LINKED0001", 0, { push: "PENDING", ref: "55" });

    expect(await push()).toEqual({ pushed: 3, failed: 0, stopped: null });
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver", "POST /api/master/driver", "POST /api/master/driver"]);
    expect(vcf.calls.slice(1).map((call) => call.body)).toEqual([
      { nama_supir: "Supir NEW0000001", no_sim: "NEW0000001", jenis_sim: "B2 UMUM", tgl_berlaku_sim: "2029-02-28", is_active: true },
      { nama_supir: "Supir NEW0000002", no_sim: "NEW0000002", jenis_sim: "B2 UMUM", tgl_berlaku_sim: "2029-02-28", is_active: true },
      { nama_supir: "Supir NEW0000003", no_sim: "NEW0000003", jenis_sim: "B2 UMUM", tgl_berlaku_sim: "2029-02-28", is_active: true },
    ]);
    // an answer without a status means normal
    expect(await row("NEW0000001")).toMatchObject(sent("1001", "NORMAL", clock.now()));
    expect(await row("NEW0000002")).toMatchObject(sent("1002", "NORMAL", clock.now()));
    expect(await row("NOTQUEUED1")).toMatchObject({ registry_push: "NONE", registry_ref: null });
    expect(await row("LINKED0001")).toMatchObject({ registry_push: "PENDING", registry_ref: "55" });

    // nothing is left to send
    expect(await push()).toEqual({ pushed: 0, failed: 0, stopped: null });
    expect(vcf.calls).toHaveLength(4);
  });

  it("takes the status the registry answers, in upper case", async () => {
    const { push, local, row, vcf, clock } = await setup();
    await local("NEW0000001", 1);
    vcf.setCreatedStatus("warning");
    await push();
    expect(await row("NEW0000001")).toMatchObject(sent("1001", "WARNING", clock.now()));
  });

  it("sends at most 50 drivers in one run", async () => {
    const { push, local, rows, vcf } = await setup();
    for (let n = 52; n >= 1; n--) await local(`CAP${String(n).padStart(7, "0")}`, n);
    expect(await push()).toEqual({ pushed: 50, failed: 0, stopped: null });
    expect(vcf.calls.filter((call) => call.url === "/api/master/driver")).toHaveLength(50);
    expect((await rows()).filter((item) => item.registry_push === "PENDING").map((item) => item.licence_no)).toEqual(["CAP0000051", "CAP0000052"]);
  });

  it("marks a driver without licence class or expiry FAILED and makes no call for it", async () => {
    const { push, local, row, vcf } = await setup();
    await local("NOCLASS001", 1, { licenceClass: null });
    await local("NODATE0001", 2, { validUntil: null });
    await local("NOTHING001", 3, { licenceClass: null, validUntil: null });
    expect(await push()).toEqual({ pushed: 0, failed: 3, stopped: null });
    expect(vcf.calls).toEqual([]);
    expect(await row("NOCLASS001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "Jenis SIM belum diisi.", registry_ref: null });
    expect(await row("NODATE0001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "Masa berlaku SIM belum diisi." });
    expect(await row("NOTHING001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "Jenis SIM dan masa berlaku SIM belum diisi." });
  });

  it("links a driver the registry already has, found through the list by its licence number", async () => {
    // the search finds both rows; only the second has the same licence number in letters and digits
    const { push, local, row, vcf, clock } = await setup({
      drivers: [registryDriver(7, { no_sim: "JK123456789", status: "normal" }), registryDriver(8, { no_sim: "jk12345678", status: "blacklist" })],
    });
    await local("JK12345678", 1);
    expect(await push()).toEqual({ pushed: 1, failed: 0, stopped: null });
    expect(vcf.calls.map((call) => `${call.method} ${call.url}`)).toEqual(["POST /api/login", "POST /api/master/driver", "GET /api/master/drivers?search=JK12345678"]);
    expect(await row("JK12345678")).toMatchObject(sent("8", "BLACKLIST", clock.now()));
  });

  it("marks the driver FAILED with the registry's message when the existing driver cannot be found or is linked here already", async () => {
    const { push, local, row, vcf } = await setup({ drivers: [registryDriver(9, { no_sim: "TAKEN00001" })] });
    const taken = { status: 422, body: { message: "The no sim has already been taken.", errors: { no_sim: ["The no sim has already been taken."] } } };
    await local("HIDDEN0001", 1);
    vcf.failOnce("/api/master/driver", taken);
    // registry id 9 belongs to another driver here already
    await local("TAKEN00001", 2);
    await local("OTHER00009", 0, { push: "NONE", ref: "9" });
    expect(await push()).toEqual({ pushed: 0, failed: 2, stopped: null });
    expect(await row("HIDDEN0001")).toMatchObject({ registry_push: "FAILED", registry_ref: null, registry_push_error: "VCF menolak: The no sim has already been taken." });
    expect(await row("TAKEN00001")).toMatchObject({
      registry_push: "FAILED",
      registry_ref: null,
      registry_push_error: "Supir dengan nomor SIM ini di VCF sudah terhubung ke supir lain di sini.",
    });
  });

  it("marks a driver FAILED for another 422 with the registry's message", async () => {
    const { push, local, row, vcf } = await setup();
    await local("NEW0000001", 1);
    vcf.failOnce("/api/master/driver", { status: 422, body: { message: "The jenis sim field must be a string.", errors: { jenis_sim: ["The jenis sim field must be a string."] } } });
    expect(await push()).toEqual({ pushed: 0, failed: 1, stopped: null });
    expect(await row("NEW0000001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "VCF menolak: The jenis sim field must be a string." });
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver"]);
  });

  it("stops at a 403: that driver is FAILED, the rest stay as they were", async () => {
    const { push, local, row, vcf } = await setup();
    await local("NEW0000001", 1);
    await local("NEW0000002", 2);
    vcf.setRole("operator");
    expect(await push()).toEqual({ pushed: 0, failed: 1, stopped: "Akun VCF tidak berhak menambah supir." });
    expect(await row("NEW0000001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "Akun VCF tidak berhak menambah supir." });
    expect(await row("NEW0000002")).toMatchObject({ registry_push: "PENDING", registry_push_error: null });
    expect(vcf.paths()).toEqual(["POST /api/login", "POST /api/master/driver"]);
  });

  it("stops before any driver when the credentials are wrong, leaving every driver as it was", async () => {
    const { push, local, rows, vcf } = await setup({ account: { username: FAKE_ACCOUNT.username, password: "wrong-password-42" } });
    await local("NEW0000001", 1);
    await local("NEW0000002", 2, { push: "FAILED", error: "VCF tidak dapat dihubungi." });
    const before = await rows();
    expect(await push()).toEqual({ pushed: 0, failed: 0, stopped: "Login VCF ditolak: username atau password salah." });
    expect(await rows()).toEqual(before);
    expect(vcf.paths()).toEqual(["POST /api/login"]);
  });

  it("stops when the login cannot be made, without trying again for the next driver", async () => {
    const { push, local, rows, vcf } = await setup();
    await local("NEW0000001", 1);
    await local("NEW0000002", 2);
    const before = await rows();
    vcf.failOnce("/api/login", 502);
    expect(await push()).toEqual({ pushed: 0, failed: 0, stopped: "Login VCF gagal: VCF menjawab HTTP 502." });
    expect(await rows()).toEqual(before);
    expect(vcf.paths()).toEqual(["POST /api/login"]);
  });

  it("stops when the registry refuses the token of a fresh login", async () => {
    const { push, local, row, vcf } = await setup();
    await local("NEW0000001", 1);
    vcf.refuseAllTokens();
    expect(await push()).toEqual({ pushed: 0, failed: 0, stopped: "VCF menolak token dari login yang baru. Pengiriman dihentikan." });
    expect(await row("NEW0000001")).toMatchObject({ registry_push: "PENDING" });
  });

  it("marks a driver FAILED on a network error or a 5xx and goes on with the next", async () => {
    const { push, local, row, vcf, clock } = await setup();
    await local("NEW0000001", 1);
    await local("NEW0000002", 2);
    await local("NEW0000003", 3);
    vcf.failOnce("/api/master/driver", "drop");
    vcf.failOnce("/api/master/driver", 503);
    expect(await push()).toEqual({ pushed: 1, failed: 2, stopped: null });
    expect(await row("NEW0000001")).toMatchObject({ registry_push: "FAILED", registry_push_error: "VCF tidak dapat dihubungi." });
    expect(await row("NEW0000002")).toMatchObject({ registry_push: "FAILED", registry_push_error: "VCF menjawab HTTP 503." });
    expect(await row("NEW0000003")).toMatchObject(sent("1001", "NORMAL", clock.now()));
  });

  it("keeps the error at most 300 characters long and without the password or the token", async () => {
    const { push, local, row, vcf } = await setup();
    await local("NEW0000001", 1);
    await push();
    // the registry is not expected to echo secrets; if it does, they do not reach the table
    await local("NEW0000002", 2);
    const token = vcf.issuedTokens[0] as string;
    vcf.failOnce("/api/master/driver", { status: 422, body: { message: `Bad ${FAKE_ACCOUNT.password} ${token} ${"x".repeat(600)}`, errors: { nama_supir: ["x"] } } });
    await push();
    const error = (await row("NEW0000002"))?.registry_push_error ?? "";
    expect(error.length).toBeLessThanOrEqual(300);
    expect(error).toMatch(/^VCF menolak: Bad /);
    expect(error).not.toContain(FAKE_ACCOUNT.password);
    expect(error).not.toContain(token);
  });

  it("does nothing without an account", async () => {
    const { push, local, row, vcf } = await setup({ account: null });
    await local("NEW0000001", 1);
    expect(await push()).toEqual({ pushed: 0, failed: 0, stopped: null });
    expect(vcf.calls).toEqual([]);
    expect(await row("NEW0000001")).toMatchObject({ registry_push: "PENDING" });
  });
});
