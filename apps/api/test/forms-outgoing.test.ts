// The forms of the outgoing flows: cleanliness, QC loading, loading (start and finish) and sealing, including
// the repeat of sealing after the supervisor asked for more load.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldApp, type FieldApp } from "./helpers/field.js";
import type { OutgoingSeed } from "./helpers/weighing.js";

type Body = Record<string, unknown>;
const fields = (response: { json: () => { error: { fields?: { field: string; message: string }[] } } }) => response.json().error.fields;
const statuses = async (ctx: FieldApp, tripId: number) => (await ctx.steps(tripId)).map((step) => `${step.step_code}${step.attempt > 1 ? `#${step.attempt}` : ""}:${step.status}`);

/** An outgoing truck after its first weighing: the cleanliness check is READY. */
async function atCleanliness(ctx: FieldApp, seed: OutgoingSeed = {}) {
  const truck = await ctx.outgoing(seed);
  const weighed = await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo });
  expect(weighed.json().result, weighed.body).toBe("SAVED");
  return truck;
}

const ALL_OK = { containerClean: true, noLiquid: true, noForeignObject: true, noPestOrNajis: true, wallsCleanDryNoLeak: true, noOdor: true };
const bulkItems = (extra: Body = {}) => ({ ...ALL_OK, flashLight: true, nozzleVisual: true, nozzleOdor: true, ...extra });
const cleanBody = (extra: Body = {}): Body => ({ items: bulkItems(), nozzleNo: 2, disposition: "OK", ...extra });

const qcLoadingBody = (ctx: FieldApp, extra: Body = {}): Body => ({ values: { FFA: 0.05, MOISTURE: 0.1, IMPURITIES: 0.02 }, tankId: ctx.tanks.olein, ...extra });

/** An outgoing bulk truck through cleanliness and QC loading: loading is READY with two prepared tank rows. */
async function atLoading(ctx: FieldApp, seed: OutgoingSeed = {}) {
  const truck = await atCleanliness(ctx, seed);
  expect((await ctx.form(await ctx.stepId(truck.tripId, "CLEANLINESS"), "cleanliness", cleanBody(), "qcop")).statusCode).toBe(200);
  const qc = await ctx.form(await ctx.stepId(truck.tripId, "QC_LOADING"), "qc-loading", qcLoadingBody(ctx, { blendTankId: ctx.tanks.olein2 }), "qcop");
  expect(qc.statusCode, qc.body).toBe(200);
  return truck;
}

const finishBody = (extra: Body = {}): Body => ({ temperatureC: 45.5, qualityOk: true, handbrakeOn: true, engineOff: true, ...extra });

describe("cleanliness", () => {
  it("OK stores every item with its label and makes QC loading ready", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    const id = await ctx.stepId(truck.tripId, "CLEANLINESS");
    const response = await ctx.form(id, "cleanliness", cleanBody({ conclusion: "Bersih dan kering" }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { id, status: "DONE", result: "PASS" }, next: { stepCode: "QC_LOADING", status: "READY" } });
    const [row] = await ctx.database.query<{ kind: string; result: string; checklist: unknown; remark: string }>("select kind, result, checklist, remark from inspections where trip_id = $1", [truck.tripId]);
    expect(row).toEqual({
      kind: "CLEANLINESS",
      result: "PASS",
      remark: "Bersih dan kering",
      checklist: [
        { key: "containerClean", item: "Kontainer bersih atau kosong dari sisa produk sebelumnya", ok: true },
        { key: "noLiquid", item: "Genangan minyak/air/cairan chemical, dan atau sejenisnya", ok: true },
        { key: "noForeignObject", item: "Benda asing/Pasir/Karat/Kotoran", ok: true },
        { key: "noPestOrNajis", item: "Pest dan najis atau segalanya", ok: true },
        { key: "wallsCleanDryNoLeak", item: "Dinding kontainer dalam keadaan bersih, kering dan tidak bocor", ok: true },
        { key: "noOdor", item: "Tidak ada bau yang dapat mempengaruhi mutu produk yang akan diisi di kontainer", ok: true },
        { key: "flashLight", item: "Monitoring Flash Light", ok: true },
        { key: "nozzleVisual", item: "Nozzle Visual", ok: true },
        { key: "nozzleOdor", item: "Nozzle Odor", ok: true },
        { key: "nozzleNo", item: "Number Nozzle Loading", value: 2 },
      ],
    });
  });

  it("NOT_OK keeps every item, rejects the truck and sends it straight to the exit", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    const response = await ctx.form(await ctx.stepId(truck.tripId, "CLEANLINESS"), "cleanliness", cleanBody({ items: bulkItems({ noLiquid: false, nozzleOdor: false }), disposition: "NOT_OK", conclusion: "Ada genangan air" }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { status: "FAILED", result: "FAIL" }, trip: { outcome: "TRUCK_REJECT" }, next: { stepCode: "CHECK_OUT", status: "READY" } });
    const [row] = await ctx.database.query<{ result: string; checklist: { key: string; ok?: boolean }[] }>("select result, checklist from inspections where trip_id = $1", [truck.tripId]);
    expect(row?.result).toBe("FAIL");
    expect(row?.checklist).toHaveLength(10);
    expect(row?.checklist.filter((item) => item.ok === false).map((item) => item.key)).toEqual(["noLiquid", "nozzleOdor"]);
    expect(await statuses(ctx, truck.tripId)).toEqual(["CHECK_IN:DONE", "WEIGH_1:DONE", "CLEANLINESS:FAILED", "QC_LOADING:SKIPPED", "LOADING:SKIPPED", "SEALING:SKIPPED", "WEIGH_2:SKIPPED", "CHECK_OUT:READY"]);
  });

  it("needs the nozzle and flash-light items for bulk, and leaves them optional for packed goods", async () => {
    const ctx = await fieldApp();
    const bulk = await atCleanliness(ctx);
    const bulkId = await ctx.stepId(bulk.tripId, "CLEANLINESS");
    const missing = await ctx.form(bulkId, "cleanliness", { items: ALL_OK, disposition: "OK" }, "qcop");
    expect(missing.statusCode).toBe(400);
    expect(fields(missing)).toEqual([
      { field: "items.flashLight", message: "Monitoring Flash Light wajib diisi untuk muatan curah." },
      { field: "items.nozzleVisual", message: "Nozzle Visual wajib diisi untuk muatan curah." },
      { field: "items.nozzleOdor", message: "Nozzle Odor wajib diisi untuk muatan curah." },
      { field: "nozzleNo", message: "Number Nozzle Loading wajib diisi untuk muatan curah." },
    ]);
    expect(fields(await ctx.form(bulkId, "cleanliness", cleanBody({ nozzleNo: 5 }), "qcop"))).toEqual([{ field: "nozzleNo", message: "Nomor nozzle 1 sampai 4." }]);
    expect(fields(await ctx.form(bulkId, "cleanliness", cleanBody({ items: bulkItems({ containerClean: undefined }) }), "qcop"))).toEqual([
      { field: "items.containerClean", message: "Kontainer bersih atau kosong dari sisa produk sebelumnya wajib diisi." },
    ]);
    expect((await ctx.form(bulkId, "cleanliness", cleanBody({ disposition: "MAYBE" }), "qcop")).statusCode).toBe(400);

    const packed = await atCleanliness(ctx, { product: "packed", dos: [800] });
    const response = await ctx.form(await ctx.stepId(packed.tripId, "CLEANLINESS"), "cleanliness", { items: ALL_OK, disposition: "OK" }, "qcop");
    expect(response.statusCode, response.body).toBe(200);
    // packed goods have no QC loading
    expect(response.json().next).toMatchObject({ stepCode: "LOADING", status: "READY" });
    expect((await ctx.database.query<{ checklist: unknown[] }>("select checklist from inspections where trip_id = $1", [packed.tripId]))[0]?.checklist).toHaveLength(6);
  });

  it("needs qc at create level, the cleanliness step ready, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    const id = await ctx.stepId(truck.tripId, "CLEANLINESS");
    expect((await ctx.form(id, "cleanliness", cleanBody(), "muat")).statusCode).toBe(403);
    expect((await ctx.form(id, "cleanliness", cleanBody(), "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(id, "cleanliness", cleanBody(), "pks1")).statusCode).toBe(403);
    expect((await ctx.form(await ctx.stepId(truck.tripId, "QC_LOADING"), "cleanliness", cleanBody(), "qcop")).json().error.code).toBe("WRONG_STEP");
    const body = cleanBody({ clientUuid: randomUUID() });
    const first = await ctx.form(id, "cleanliness", body, "qcop");
    expect((await ctx.form(id, "cleanliness", body, "qcop")).json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from inspections where trip_id = $1", [truck.tripId])).toBe(1);
    expect((await ctx.form(id, "cleanliness", cleanBody(), "qcop")).json().error.code).toBe("NOT_READY");
  });
});

describe("qc-loading", () => {
  it("records the figures and the tank, issues the certificate number and prepares one loading row per tank", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    await ctx.forceReady(truck.tripId, "QC_LOADING");
    const id = await ctx.stepId(truck.tripId, "QC_LOADING");
    const response = await ctx.form(id, "qc-loading", qcLoadingBody(ctx, { blendTankId: ctx.tanks.olein2, remark: "Sampel tangki 1" }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { id, status: "DONE", result: "PASS" }, next: { stepCode: "LOADING", status: "READY" }, certificateNo: "0001/COA/SMK/XI/2026" });
    const [check] = await ctx.database.query<Record<string, unknown>>(
      "select id::int as id, stage, tank_id, certificate_no, decision, disposition, remark from quality_checks where trip_id = $1",
      [truck.tripId],
    );
    expect(check).toMatchObject({ stage: "LOADING", tank_id: ctx.tanks.olein, certificate_no: "0001/COA/SMK/XI/2026", decision: null, disposition: null, remark: "Sampel tangki 1" });
    expect(await ctx.database.query("select parameter_code, value::text as value from quality_values where quality_check_id = $1 order by parameter_code", [check?.id])).toEqual([
      { parameter_code: "FFA", value: "0.0500" },
      { parameter_code: "IMPURITIES", value: "0.0200" },
      { parameter_code: "MOISTURE", value: "0.1000" },
    ]);
    const loading = await ctx.stepId(truck.tripId, "LOADING");
    expect(await ctx.database.query("select kind, tank_id, trip_step_id::int as trip_step_id, started_at, finished_at from handlings where trip_id = $1 order by id", [truck.tripId])).toEqual([
      { kind: "LOAD", tank_id: ctx.tanks.olein, trip_step_id: loading, started_at: null, finished_at: null },
      { kind: "LOAD", tank_id: ctx.tanks.olein2, trip_step_id: loading, started_at: null, finished_at: null },
    ]);
  });

  it("refuses missing or implausible figures, a blend tank equal to the tank, and a tank of another product", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    await ctx.forceReady(truck.tripId, "QC_LOADING");
    const id = await ctx.stepId(truck.tripId, "QC_LOADING");
    const send = (body: Body) => ctx.form(id, "qc-loading", body, "qcop");
    expect(fields(await send(qcLoadingBody(ctx, { values: { MOISTURE: 0.1 } })))).toEqual([{ field: "values.FFA", message: "FFA wajib diisi." }]);
    expect(fields(await send(qcLoadingBody(ctx, { values: { FFA: 30, MOISTURE: 9 } })))).toEqual([
      { field: "values.FFA", message: "FFA harus antara 0 dan 20." },
      { field: "values.MOISTURE", message: "Moisture (kadar air) harus antara 0 dan 5." },
    ]);
    // the parameters of migration 0006 are switched off until QC uses them
    expect(fields(await send(qcLoadingBody(ctx, { values: { FFA: 0.05, MNI: 0.02, IV: 56.5 } })))).toEqual([
      { field: "values.MNI", message: "M dan I belum dipakai." },
      { field: "values.IV", message: "IV belum dipakai." },
    ]);
    expect(fields(await send(qcLoadingBody(ctx, { blendTankId: ctx.tanks.olein })))).toEqual([{ field: "blendTankId", message: "Tangki blend harus berbeda dari tangki." }]);
    expect(fields(await send(qcLoadingBody(ctx, { tankId: ctx.tanks.cpo })))).toEqual([{ field: "tankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    expect(fields(await send(qcLoadingBody(ctx, { blendTankId: ctx.tanks.cpo })))).toEqual([{ field: "blendTankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    expect((await send({ values: { FFA: 0.05 } })).statusCode).toBe(400);
    expect(await ctx.count("select count(*)::int as n from quality_checks")).toBe(0);
    expect(await ctx.count("select count(*)::int as n from document_counters where counter_key like 'COA/%'")).toBe(0);
  });

  it("needs qc at create level, the QC loading step, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    const early = await ctx.form(await ctx.stepId(truck.tripId, "QC_LOADING"), "qc-loading", qcLoadingBody(ctx), "qcop");
    expect(early.json().error.code).toBe("NOT_READY");
    expect((await ctx.form(await ctx.stepId(truck.tripId, "CLEANLINESS"), "qc-loading", qcLoadingBody(ctx), "qcop")).json().error.code).toBe("WRONG_STEP");
    await ctx.forceReady(truck.tripId, "QC_LOADING");
    const id = await ctx.stepId(truck.tripId, "QC_LOADING");
    expect((await ctx.form(id, "qc-loading", qcLoadingBody(ctx), "muat")).statusCode).toBe(403);
    expect((await ctx.form(id, "qc-loading", qcLoadingBody(ctx), "qclihat")).statusCode).toBe(403);
    const body = qcLoadingBody(ctx, { clientUuid: randomUUID() });
    const first = await ctx.form(id, "qc-loading", body, "qcop");
    expect((await ctx.form(id, "qc-loading", body, "qcop")).json()).toEqual(first.json());
    expect(await ctx.database.query("select certificate_no from quality_checks")).toEqual([{ certificate_no: "0001/COA/SMK/XI/2026" }]);
    expect(await ctx.count("select count(*)::int as n from handlings")).toBe(1);
  });
});

describe("loading", () => {
  it("start marks the step in progress; finish fills the prepared rows, issues the delivery note and makes sealing ready", async () => {
    const ctx = await fieldApp();
    const truck = await atLoading(ctx);
    const id = await ctx.stepId(truck.tripId, "LOADING");
    const started = await ctx.form(id, "loading/start", { startedAt: "2026-11-20T02:50:00.000Z" }, "muat");
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ step: { id, status: "IN_PROGRESS", startedAt: "2026-11-20T02:50:00.000Z" }, next: null });
    expect((await ctx.call("GET", "/api/work/steps", "muat")).json().items).toEqual([expect.objectContaining({ id, status: "IN_PROGRESS" })]);
    expect((await ctx.form(id, "loading/start", {}, "muat")).json().error.code).toBe("NOT_READY");

    ctx.clock.advance(30 * 60_000);
    const finished = await ctx.form(id, "loading/finish", finishBody({ remark: "Muat lancar" }), "muat");
    expect(finished.statusCode, finished.body).toBe(200);
    expect(finished.json()).toMatchObject({
      step: { id, status: "DONE", result: "PASS", startedAt: "2026-11-20T02:50:00.000Z", finishedAt: "2026-11-20T03:30:00.000Z" },
      next: { stepCode: "SEALING", status: "READY" },
      deliveryNoteNo: "0001/SJ/SMK/XI/2026",
    });
    expect(
      await ctx.database.query(
        "select tank_id, started_at, finished_at, temperature_c::text as temperature_c, log_sheet, remark, (select username from users where id = operator_id) as operator from handlings where trip_id = $1 order by id",
        [truck.tripId],
      ),
    ).toEqual(
      [ctx.tanks.olein, ctx.tanks.olein2].map((tank_id) => ({
        tank_id,
        started_at: new Date("2026-11-20T02:50:00.000Z"),
        finished_at: new Date("2026-11-20T03:30:00.000Z"),
        temperature_c: "45.5",
        log_sheet: { qualityOk: true, handbrakeOn: true, engineOff: true },
        remark: "Muat lancar",
        operator: "muat",
      })),
    );
    expect(await ctx.database.query("select delivery_note_no from trips where id = $1", [truck.tripId])).toEqual([{ delivery_note_no: "0001/SJ/SMK/XI/2026" }]);
  });

  it("finishes in one go from READY when the start time is given, and refuses it without", async () => {
    const ctx = await fieldApp();
    const truck = await atLoading(ctx);
    const id = await ctx.stepId(truck.tripId, "LOADING");
    const bare = await ctx.form(id, "loading/finish", finishBody(), "muat");
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error).toEqual({ code: "NOT_READY", message: "Muat belum dimulai. Kirim waktu mulai atau tekan Mulai dulu." });
    const done = await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z", finishedAt: "2026-11-20T02:55:00.000Z", qualityOk: false }), "muat");
    expect(done.statusCode, done.body).toBe(200);
    // quality NOT OK is recorded and changes nothing else
    expect(done.json()).toMatchObject({ step: { status: "DONE", startedAt: "2026-11-20T02:30:00.000Z", finishedAt: "2026-11-20T02:55:00.000Z" }, next: { stepCode: "SEALING" }, trip: { outcome: null } });
    expect(await ctx.database.query("select log_sheet->>'qualityOk' as ok from handlings where trip_id = $1", [truck.tripId])).toEqual([{ ok: "false" }, { ok: "false" }]);
  });

  it("checks the times and the temperature", async () => {
    const ctx = await fieldApp();
    const truck = await atLoading(ctx);
    const id = await ctx.stepId(truck.tripId, "LOADING");
    expect(fields(await ctx.form(id, "loading/start", { startedAt: "2026-11-20T03:10:00.000Z" }, "muat"))).toEqual([{ field: "startedAt", message: "Waktu mulai tidak boleh di masa depan." }]);
    expect((await ctx.form(id, "loading/start", { startedAt: "kemarin" }, "muat")).statusCode).toBe(400);
    expect(fields(await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z", finishedAt: "2026-11-20T02:20:00.000Z" }), "muat"))).toEqual([
      { field: "finishedAt", message: "Waktu selesai tidak boleh sebelum waktu mulai." },
    ]);
    expect(fields(await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z", finishedAt: "2026-11-20T03:20:00.000Z" }), "muat"))).toEqual([
      { field: "finishedAt", message: "Waktu selesai tidak boleh di masa depan." },
    ]);
    expect(fields(await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z", temperatureC: 151 }), "muat"))).toEqual([
      { field: "temperatureC", message: "Suhu harus antara 0 dan 150 °C." },
    ]);
    expect(fields(await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z", engineOff: undefined }), "muat"))).toEqual([{ field: "engineOff", message: "Mesin wajib diisi." }]);
    expect(await ctx.database.query("select status from trip_steps where id = $1", [id])).toEqual([{ status: "READY" }]);
  });

  it("QC loading does not require FFA while FFA is switched off, and refuses it then", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx);
    await ctx.forceReady(truck.tripId, "QC_LOADING");
    const id = await ctx.stepId(truck.tripId, "QC_LOADING");
    await ctx.database.query("update quality_parameters set is_active = false where code = 'FFA'");
    expect(fields(await ctx.form(id, "qc-loading", qcLoadingBody(ctx), "qcop"))).toEqual([{ field: "values.FFA", message: "FFA belum dipakai." }]);
    const response = await ctx.form(id, "qc-loading", qcLoadingBody(ctx, { values: { MOISTURE: 0.1 } }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
  });

  it("takes a time up to 5 minutes ahead of the server as now, for a phone whose clock runs fast", async () => {
    const ctx = await fieldApp();
    const truck = await atLoading(ctx);
    const id = await ctx.stepId(truck.tripId, "LOADING");
    // the test clock stands at 03:00
    expect(fields(await ctx.form(id, "loading/start", { startedAt: "2026-11-20T03:05:00.001Z" }, "muat"))).toEqual([
      { field: "startedAt", message: "Waktu mulai tidak boleh di masa depan." },
    ]);
    const started = await ctx.form(id, "loading/start", { startedAt: "2026-11-20T03:04:00.000Z" }, "muat");
    expect(started.statusCode, started.body).toBe(200);
    expect(await ctx.database.query("select started_at = '2026-11-20T03:00:00Z'::timestamptz as at_now from trip_steps where id = $1", [id])).toEqual([{ at_now: true }]);

    expect(fields(await ctx.form(id, "loading/finish", finishBody({ finishedAt: "2026-11-20T03:06:00.000Z" }), "muat"))).toEqual([
      { field: "finishedAt", message: "Waktu selesai tidak boleh di masa depan." },
    ]);
    const done = await ctx.form(id, "loading/finish", finishBody({ finishedAt: "2026-11-20T03:05:00.000Z" }), "muat");
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ step: { status: "DONE", startedAt: "2026-11-20T03:00:00.000Z", finishedAt: "2026-11-20T03:00:00.000Z" } });
  });

  it("creates the loading row of packed goods without a tank", async () => {
    const ctx = await fieldApp();
    const truck = await atCleanliness(ctx, { product: "packed", dos: [800] });
    await ctx.form(await ctx.stepId(truck.tripId, "CLEANLINESS"), "cleanliness", { items: ALL_OK, disposition: "OK" }, "qcop");
    const id = await ctx.stepId(truck.tripId, "LOADING");
    expect((await ctx.form(id, "loading/start", {}, "muat")).json().step.startedAt).toBe("2026-11-20T03:00:00.000Z");
    expect((await ctx.form(id, "loading/finish", finishBody({ temperatureC: 30 }), "muat")).statusCode).toBe(200);
    expect(await ctx.database.query("select kind, tank_id, trip_step_id::int as trip_step_id from handlings where trip_id = $1", [truck.tripId])).toEqual([{ kind: "LOAD", tank_id: null, trip_step_id: id }]);
  });

  it("needs loading at create level and stores a resend of start and finish once", async () => {
    const ctx = await fieldApp();
    const truck = await atLoading(ctx);
    const id = await ctx.stepId(truck.tripId, "LOADING");
    expect((await ctx.form(id, "loading/start", {}, "qcop")).statusCode).toBe(403);
    expect((await ctx.form(id, "loading/start", {}, "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(id, "loading/finish", finishBody(), "pks1")).statusCode).toBe(403);
    expect((await ctx.form(await ctx.stepId(truck.tripId, "SEALING"), "loading/start", {}, "lapangan")).json().error.code).toBe("WRONG_STEP");
    const start = { clientUuid: randomUUID() };
    const first = await ctx.form(id, "loading/start", start, "muat");
    expect((await ctx.form(id, "loading/start", start, "muat")).json()).toEqual(first.json());
    const finish = finishBody({ clientUuid: randomUUID() });
    const done = await ctx.form(id, "loading/finish", finish, "muat");
    expect((await ctx.form(id, "loading/finish", finish, "muat")).json()).toEqual(done.json());
    // the start uuid is not a finish
    expect((await ctx.form(id, "loading/finish", { ...finishBody(), ...start }, "muat")).json().error.code).toBe("UUID_REUSED");
    expect(await ctx.database.query("select last_no from document_counters where counter_key like 'SJ/%'")).toEqual([{ last_no: 1 }]);
  });
});

describe("sealing", () => {
  const atSealing = async (ctx: FieldApp) => {
    const truck = await atLoading(ctx, { closeCargo: true });
    const id = await ctx.stepId(truck.tripId, "LOADING");
    expect((await ctx.form(id, "loading/finish", finishBody({ startedAt: "2026-11-20T02:30:00.000Z" }), "muat")).statusCode).toBe(200);
    return truck;
  };

  it("puts stock seals with their position and a photo on the truck and makes the second weighing ready", async () => {
    const ctx = await fieldApp();
    const truck = await atSealing(ctx);
    const id = await ctx.stepId(truck.tripId, "SEALING");
    const [s1, s2] = ctx.seals;
    const photo = await ctx.photo("segel");
    const response = await ctx.form(id, "sealing", { seals: [{ sealId: s1, position: "Manhole" }, { sealId: s2, position: "Bottom valve" }], remark: "Dua segel", photoFileIds: [photo] }, "segel");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { status: "DONE", result: "PASS" }, next: { stepCode: "WEIGH_2", status: "READY" } });
    expect(await ctx.database.query("select seal_no, position, trip_step_id::int as trip_step_id, removed_at from trip_seals where trip_id = $1 order by seal_no", [truck.tripId])).toEqual([
      { seal_no: "LC-0001", position: "Manhole", trip_step_id: id, removed_at: null },
      { seal_no: "LC-0002", position: "Bottom valve", trip_step_id: id, removed_at: null },
    ]);
    expect(await ctx.count("select count(*)::int as n from seals where status = 'USED'")).toBe(2);
    expect(await ctx.database.query("select step_code, label from trip_files where file_id = $1", [photo])).toEqual([{ step_code: "SEALING", label: "sealing" }]);
  });

  it("after more load is asked for, every seal still on the truck must be listed as removed before new ones go on", async () => {
    const ctx = await fieldApp();
    const truck = await atSealing(ctx);
    const [s1, s2, s3, s4] = ctx.seals;
    await ctx.form(await ctx.stepId(truck.tripId, "SEALING"), "sealing", { seals: [{ sealId: s1 }, { sealId: s2 }] }, "segel");
    // the second weighing finds too little load; the supervisor asks for more
    const pending = (await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 40_000, plateRead: truck.plateNo })).json();
    expect(pending.exception.type).toBe("NET_OUT");
    expect((await ctx.call("POST", `/api/exceptions/${pending.exception.id}/decide`, "atasan", { decision: "ADD_LOAD" })).statusCode).toBe(200);
    const loading = await ctx.stepId(truck.tripId, "LOADING");
    expect((await ctx.form(loading, "loading/finish", finishBody({ startedAt: "2026-11-20T02:58:00.000Z" }), "muat")).statusCode).toBe(200);
    // the second loading round copied the tanks of the first
    expect(await ctx.database.query("select tank_id from handlings where trip_step_id = $1 order by id", [loading])).toEqual([{ tank_id: ctx.tanks.olein }, { tank_id: ctx.tanks.olein2 }]);

    const id = await ctx.stepId(truck.tripId, "SEALING");
    const detail = (await ctx.call("GET", `/api/work/steps/${id}`, "segel")).json().form;
    const old = detail.sealsInPlace as { id: number; sealNo: string }[];
    expect(old.map((seal) => seal.sealNo)).toEqual(["LC-0001", "LC-0002"]);

    const send = (body: Body) => ctx.form(id, "sealing", body, "segel");
    const kept = await send({ seals: [{ sealId: s3 }] });
    expect(kept.statusCode).toBe(409);
    expect(kept.json().error).toEqual({ code: "OLD_SEALS_IN_PLACE", message: "Segel lama masih terpasang: LC-0001, LC-0002. Tandai dibuka dulu." });
    expect((await send({ seals: [{ sealId: s3 }], removed: [{ tripSealId: old[0]?.id, reason: "Tambah muatan" }] })).json().error.code).toBe("OLD_SEALS_IN_PLACE");
    expect(fields(await send({ seals: [{ sealId: s3 }], removed: [{ tripSealId: 999_999, reason: "Tambah muatan" }] }))).toEqual([{ field: "removed.0.tripSealId", message: "Segel ini tidak terpasang pada truk ini." }]);
    expect(fields(await send({ seals: [{ sealId: s3 }], removed: old.map((seal) => ({ tripSealId: seal.id, reason: "" })) }))).toEqual([
      { field: "removed.0.reason", message: "Alasan membuka segel wajib diisi." },
      { field: "removed.1.reason", message: "Alasan membuka segel wajib diisi." },
    ]);

    const response = await send({ seals: [{ sealId: s3 }, { sealId: s4 }], removed: old.map((seal) => ({ tripSealId: seal.id, reason: "Tambah muatan" })) });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      await ctx.database.query("select seal_no, remove_reason, removed_at is not null as removed, (select username from users where id = removed_by) as remover from trip_seals where trip_id = $1 order by seal_no", [truck.tripId]),
    ).toEqual([
      { seal_no: "LC-0001", remove_reason: "Tambah muatan", removed: true, remover: "segel" },
      { seal_no: "LC-0002", remove_reason: "Tambah muatan", removed: true, remover: "segel" },
      { seal_no: "LC-0003", remove_reason: null, removed: false, remover: null },
      { seal_no: "LC-0004", remove_reason: null, removed: false, remover: null },
    ]);
  });

  it("takes one to four available seals, needs sealing at create level, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const truck = await atSealing(ctx);
    const id = await ctx.stepId(truck.tripId, "SEALING");
    const [s1, s2, s3, s4, s5] = ctx.seals;
    expect(fields(await ctx.form(id, "sealing", { seals: [] }, "segel"))).toEqual([{ field: "seals", message: "Pilih 1 sampai 4 segel." }]);
    expect(fields(await ctx.form(id, "sealing", { seals: [s1, s2, s3, s4, s5].map((sealId) => ({ sealId })) }, "segel"))).toEqual([{ field: "seals", message: "Pilih 1 sampai 4 segel." }]);
    await ctx.database.query("update seals set status = 'USED' where id = $1", [s5]);
    expect((await ctx.form(id, "sealing", { seals: [{ sealId: s5 }] }, "segel")).json().error.code).toBe("SEAL_NOT_AVAILABLE");
    expect((await ctx.form(id, "sealing", { seals: [{ sealId: s1 }] }, "muat")).statusCode).toBe(403);
    expect((await ctx.form(id, "sealing", { seals: [{ sealId: s1 }] }, "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(await ctx.stepId(truck.tripId, "LOADING"), "sealing", { seals: [{ sealId: s1 }] }, "lapangan")).json().error.code).toBe("WRONG_STEP");
    const body = { clientUuid: randomUUID(), seals: [{ sealId: s1 }] };
    const first = await ctx.form(id, "sealing", body, "segel");
    expect(first.statusCode, first.body).toBe(200);
    expect((await ctx.form(id, "sealing", body, "segel")).json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from trip_seals")).toBe(1);
    expect((await ctx.form(id, "sealing", { seals: [{ sealId: s2 }] }, "segel")).json().error.code).toBe("NOT_READY");
  });
});
