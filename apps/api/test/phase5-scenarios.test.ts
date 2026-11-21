// Whole journeys through the phone forms and the weighbridge routes only, from check-in to the returned card;
// the temporary route POST /api/trips/:id/steps/:stepCode/complete is never called.
import { describe, expect, it } from "vitest";
import { fieldApp, type FieldApp } from "./helpers/field.js";

type Body = Record<string, unknown>;

/** Sends a form to the latest attempt of the step and expects it saved. */
async function fill(ctx: FieldApp, tripId: number, stepCode: string, path: string, body: Body, as: string) {
  const response = await ctx.form(await ctx.stepId(tripId, stepCode), path, body, as);
  expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
  return response.json();
}
const statuses = async (ctx: FieldApp, tripId: number) => (await ctx.steps(tripId)).map((step) => `${step.step_code}${step.attempt > 1 ? `#${step.attempt}` : ""}:${step.status}`);
/** The temporary route was not used for this trip. */
const genericSteps = (ctx: FieldApp, tripId: number) => ctx.count("select count(*)::int as n from audit_log where entity_id = $1 and action in ('STEP_DONE', 'STEP_REJECTED')", [tripId]);

const clean = { items: { containerClean: true, noLiquid: true, noForeignObject: true, noPestOrNajis: true, wallsCleanDryNoLeak: true, noOdor: true, flashLight: true, nozzleVisual: true, nozzleOdor: true }, nozzleNo: 1, disposition: "OK" };
const finish = (startedAt?: string) => ({ temperatureC: 48, qualityOk: true, handbrakeOn: true, engineOff: true, ...(startedAt ? { startedAt } : {}) });

describe("phase 5 scenarios", () => {
  it("(a) incoming CPO: seal check, first weighing, QC hold approved, unloading with the tank check, second weighing, card returned", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming({ plate: "BK 9501 AA" });
    await fill(ctx, truck.tripId, "SEAL_CHECK", "seal-check", { seals: [{ sealNo: "PKS-9501", intact: true }], result: "PASS" }, "satpam");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo })).json()).toMatchObject({ result: "SAVED", trip: { currentStep: "QC" } });

    const hold = await fill(ctx, truck.tripId, "QC", "qc-receiving", { values: { FFA: 5.6, MOISTURE: 0.15 }, disposition: "HOLD", reasonCode: "FFA_OUT", remark: "FFA di atas spek" }, "qcop");
    const inbox = (await ctx.call("GET", "/api/exceptions?status=PENDING", "qcspv")).json().items;
    expect(inbox).toEqual([expect.objectContaining({ id: hold.exception.id, type: "QC_HOLD", trip: expect.objectContaining({ id: truck.tripId }) })]);
    expect((await ctx.call("POST", `/api/exceptions/${hold.exception.id}/decide`, "qcspv", { decision: "APPROVE", reason: "Disetujui untuk tangki campuran" })).statusCode).toBe(200);

    const unloaded = await fill(ctx, truck.tripId, "UNLOADING", "unloading", {
      tankId: ctx.tanks.cpo, doorNo: 2, wood: false, wire: false, plastic: false, handbrakeOn: true, engineOn: false, manholeOpen: true, dischargeValveActive: true, tankEmpty: true,
    }, "bongkar");
    expect(unloaded.next).toMatchObject({ stepCode: "WEIGH_2" });
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 10_000, plateRead: truck.plateNo })).json()).toMatchObject({ result: "SAVED", trip: { netKg: 20_000, currentStep: "CHECK_OUT" } });
    expect((await ctx.call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid })).json().trip).toMatchObject({ status: "COMPLETED" });

    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "SEAL_CHECK:DONE", "WEIGH_1:DONE", "QC:DONE", "UNLOADING:DONE", "TANK_CHECK:DONE", "RESEAL:SKIPPED", "WEIGH_2:DONE", "CHECK_OUT:DONE",
    ]);
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "COMPLETED", outcome: "OK" });
    expect(await genericSteps(ctx, truck.tripId)).toBe(0);
    // the history of the trip tells the story in short
    const history = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(truck.tripId, "CHECK_OUT")}`, "pos")).json().form.history;
    expect(history.find((item: { stepCode: string }) => item.stepCode === "QC").summary).toMatchObject({ disposition: "HOLD", decision: "PASS", values: { FFA: 5.6, MOISTURE: 0.15 } });
    expect(history.find((item: { stepCode: string }) => item.stepCode === "UNLOADING").summary).toMatchObject({ tanks: ["TK-CPO"] });
  });

  it("(b) outgoing bulk with one round of more load: the second sealing removes the first seals", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.outgoing({ plate: "BK 9502 BB", closeCargo: true });
    const [s1, s2, s3] = ctx.seals;
    expect((await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    await fill(ctx, truck.tripId, "CLEANLINESS", "cleanliness", clean, "qcop");
    const qc = await fill(ctx, truck.tripId, "QC_LOADING", "qc-loading", { values: { FFA: 0.04, MOISTURE: 0.03 }, tankId: ctx.tanks.olein }, "qcop");
    expect(qc.certificateNo).toBe("0001/COA/SMK/XI/2026");
    await fill(ctx, truck.tripId, "LOADING", "loading/start", {}, "muat");
    ctx.clock.advance(20 * 60_000);
    const loaded = await fill(ctx, truck.tripId, "LOADING", "loading/finish", finish(), "muat");
    expect(loaded.deliveryNoteNo).toBe("0001/SJ/SMK/XI/2026");
    await fill(ctx, truck.tripId, "SEALING", "sealing", { seals: [{ sealId: s1, position: "Manhole" }, { sealId: s2, position: "Valve" }] }, "segel");

    // too little: the supervisor asks for more load
    const short = (await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 40_000, plateRead: truck.plateNo })).json();
    expect(short.exception.type).toBe("NET_OUT");
    expect((await ctx.call("POST", `/api/exceptions/${short.exception.id}/decide`, "atasan", { decision: "ADD_LOAD" })).statusCode).toBe(200);

    await fill(ctx, truck.tripId, "LOADING", "loading/start", {}, "muat");
    ctx.clock.advance(5 * 60_000);
    const again = await fill(ctx, truck.tripId, "LOADING", "loading/finish", finish(), "muat");
    expect(again.deliveryNoteNo).toBe("0001/SJ/SMK/XI/2026");
    const old = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(truck.tripId, "SEALING")}`, "segel")).json().form.sealsInPlace as { id: number }[];
    await fill(ctx, truck.tripId, "SEALING", "sealing", { seals: [{ sealId: s3, position: "Manhole" }], removed: old.map((seal) => ({ tripSealId: seal.id, reason: "Tambah muatan" })) }, "segel");

    const full = (await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 45_000, plateRead: truck.plateNo })).json();
    expect(full.exception.type).toBe("NET_OUT");
    const ok = await ctx.call("POST", `/api/exceptions/${full.exception.id}/decide`, "atasan", { decision: "OK" });
    expect(ok.json().weighing).toMatchObject({ stage: 2, weightKg: 45_000 });
    expect((await ctx.call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid })).json().trip).toMatchObject({ status: "COMPLETED" });

    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "WEIGH_1:DONE", "CLEANLINESS:DONE", "QC_LOADING:DONE", "LOADING:DONE", "LOADING#2:DONE", "SEALING:DONE", "SEALING#2:DONE", "WEIGH_2:FAILED", "WEIGH_2#2:DONE", "CHECK_OUT:DONE",
    ]);
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "COMPLETED", outcome: "OK", tare_kg: 15_000, gross_kg: 45_000, net_kg: 30_000 });
    expect(await ctx.database.query("select seal_no, removed_at is not null as removed from trip_seals where trip_id = $1 order by seal_no", [truck.tripId])).toEqual([
      { seal_no: "LC-0001", removed: true },
      { seal_no: "LC-0002", removed: true },
      { seal_no: "LC-0003", removed: false },
    ]);
    expect(await ctx.count("select count(*)::int as n from handlings where trip_id = $1 and finished_at is not null", [truck.tripId])).toBe(2);
    expect(await genericSteps(ctx, truck.tripId)).toBe(0);
  });

  it("(c) incoming CPO rejected at QC: reseal, weighing out, card returned, REJECTED with SPEC_REJECT", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming({ plate: "BK 9503 CC" });
    await fill(ctx, truck.tripId, "SEAL_CHECK", "seal-check", { seals: [{ sealNo: "PKS-9503", intact: true }], result: "PASS" }, "satpam");
    await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo });
    const hold = await fill(ctx, truck.tripId, "QC", "qc-receiving", { values: { FFA: 9.5, MOISTURE: 0.9 }, disposition: "NOT_OK", reasonCode: "FFA_MI_OUT" }, "qcop");
    expect((await ctx.call("POST", `/api/exceptions/${hold.exception.id}/decide`, "qcspv", { decision: "REJECT", reason: "FFA dan M&I di luar spek" })).statusCode).toBe(200);

    const resealed = await fill(ctx, truck.tripId, "RESEAL", "reseal", { seals: [{ sealId: ctx.seals[0] }] }, "segel");
    expect(resealed.outSpecLetterNo).toBe("0001/OS/SMK/XI/2026");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 29_990, plateRead: truck.plateNo })).json()).toMatchObject({ result: "SAVED", trip: { currentStep: "CHECK_OUT" } });
    expect((await ctx.call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid })).json().trip).toMatchObject({ status: "REJECTED" });

    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "SEAL_CHECK:DONE", "WEIGH_1:DONE", "QC:FAILED", "UNLOADING:SKIPPED", "TANK_CHECK:SKIPPED", "RESEAL:DONE", "WEIGH_2:DONE", "CHECK_OUT:DONE",
    ]);
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "REJECTED", outcome: "SPEC_REJECT" });
    expect(await ctx.database.query("select out_spec_letter_no from trips where id = $1", [truck.tripId])).toEqual([{ out_spec_letter_no: "0001/OS/SMK/XI/2026" }]);
    expect(await genericSteps(ctx, truck.tripId)).toBe(0);
  });
});
