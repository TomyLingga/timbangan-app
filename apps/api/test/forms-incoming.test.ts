// The forms of the incoming CPO flow: seal check, QC at receiving with its hold and decision, reseal after a
// rejection, and unloading that also completes the tank check.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldApp, type FieldApp } from "./helpers/field.js";
import type { SeededTrip } from "./helpers/weighing.js";

type Body = Record<string, unknown>;

/** An incoming truck past the seal check and the first weighing: QC is READY. */
async function atQc(ctx: FieldApp, seed: Parameters<FieldApp["incoming"]>[0] = {}): Promise<SeededTrip> {
  const truck = await ctx.incoming(seed);
  const sealed = await ctx.call("POST", `/api/trips/${truck.tripId}/steps/SEAL_CHECK/complete`, "lapangan", { result: "PASS" });
  expect(sealed.statusCode, sealed.body).toBe(200);
  const weighed = await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo });
  expect(weighed.json().result).toBe("SAVED");
  return truck;
}

const qcBody = (extra: Body = {}): Body => ({ values: { FFA: 3.25, MOISTURE: 0.12, IMPURITIES: 0.02 }, disposition: "OK", ...extra });
const holdBody = (extra: Body = {}): Body => qcBody({ values: { FFA: 6.1, MOISTURE: 0.12 }, disposition: "HOLD", reasonCode: "FFA_OUT", ...extra });

/** A QC hold raised on a fresh truck; answers the truck and the exception id. */
async function held(ctx: FieldApp, body: Body = holdBody()) {
  const truck = await atQc(ctx);
  const response = await ctx.form(await ctx.stepId(truck.tripId, "QC"), "qc-receiving", body, "qcop");
  expect(response.statusCode, response.body).toBe(200);
  return { truck, exceptionId: response.json().exception.id as number };
}

/** A truck rejected at QC: RESEAL is READY. */
async function rejected(ctx: FieldApp) {
  const { truck, exceptionId } = await held(ctx, holdBody({ disposition: "NOT_OK", reasonCode: "FFA_MI_OUT" }));
  const decided = await ctx.call("POST", `/api/exceptions/${exceptionId}/decide`, "qcspv", { decision: "REJECT" });
  expect(decided.statusCode, decided.body).toBe(200);
  return truck;
}

const statuses = async (ctx: FieldApp, tripId: number) => (await ctx.steps(tripId)).map((step) => `${step.step_code}:${step.status}${step.result ? `/${step.result}` : ""}`);
const fields = (response: { json: () => { error: { fields?: { field: string; message: string }[] } } }) => response.json().error.fields;

describe("seal-check", () => {
  it("records each seal of the letter with a photo, finishes the step and makes the first weighing ready", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    const photo = await ctx.photo("satpam");
    const clientUuid = randomUUID();
    const response = await ctx.form(id, "seal-check", { clientUuid, seals: [{ sealNo: " pks-001 ", intact: true }, { sealNo: "PKS-002", intact: true, note: "Agak longgar" }], result: "PASS", remark: "Segel utuh", photoFileIds: [photo] }, "satpam");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step).toMatchObject({ id, stepCode: "SEAL_CHECK", status: "DONE", result: "PASS", note: "Segel utuh" });
    expect(body.trip).toMatchObject({ id: truck.tripId, currentStep: "WEIGH_1", outcome: null });
    expect(body.next).toMatchObject({ stepCode: "WEIGH_1", status: "READY" });

    const [row] = await ctx.database.query<{ kind: string; result: string; checklist: unknown; remark: string; client_uuid: string; trip_step_id: number }>(
      "select kind, result, checklist, remark, client_uuid::text as client_uuid, trip_step_id::int as trip_step_id from inspections where trip_id = $1",
      [truck.tripId],
    );
    expect(row).toEqual({
      kind: "SEAL_CHECK",
      result: "PASS",
      remark: "Segel utuh",
      client_uuid: clientUuid,
      trip_step_id: id,
      checklist: [
        { key: "seal", item: "Segel PKS-001", value: "PKS-001", ok: true, note: null },
        { key: "seal", item: "Segel PKS-002", value: "PKS-002", ok: true, note: "Agak longgar" },
      ],
    });
    expect(await ctx.database.query("select file_id::int as file_id, step_code, label from trip_files where trip_id = $1", [truck.tripId])).toEqual([{ file_id: photo, step_code: "SEAL_CHECK", label: "seal_check" }]);
    expect(await ctx.count("select count(*)::int as n from audit_log where action = 'FORM_SEAL_CHECK' and entity_id = $1", [truck.tripId])).toBe(1);
  });

  it("rejects the truck on FAIL, which needs a remark", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    const bare = await ctx.form(id, "seal-check", { seals: [{ sealNo: "PKS-001", intact: false }], result: "FAIL" }, "satpam");
    expect(bare.statusCode).toBe(400);
    expect(fields(bare)).toEqual([{ field: "remark", message: "Catatan wajib diisi bila hasilnya gagal." }]);
    const response = await ctx.form(id, "seal-check", { seals: [{ sealNo: "PKS-001", intact: false, note: "Putus" }], result: "FAIL", remark: "Segel putus" }, "satpam");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { status: "FAILED", result: "FAIL" }, trip: { outcome: "SEAL_REJECT" }, next: { stepCode: "RESEAL", status: "READY" } });
    expect(await ctx.database.query("select result from inspections where trip_id = $1", [truck.tripId])).toEqual([{ result: "FAIL" }]);
  });

  it("checks the seals, the photos and the result", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const other = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    const send = (body: Body) => ctx.form(id, "seal-check", body, "satpam");
    expect(fields(await send({ seals: [], result: "PASS" }))).toEqual([{ field: "seals", message: "Isi paling sedikit satu segel." }]);
    expect(fields(await send({ seals: [{ sealNo: "A1", intact: true }, { sealNo: "a1", intact: true }], result: "PASS" }))).toEqual([{ field: "seals", message: "Nomor segel A1 tertulis dua kali." }]);
    expect((await send({ seals: [{ sealNo: "A1" }], result: "PASS" })).statusCode).toBe(400);
    expect((await send({ seals: [{ sealNo: "A1", intact: true }], result: "MAYBE" })).statusCode).toBe(400);
    expect((await send({ seals: [{ sealNo: "A1", intact: true }], result: "PASS", clientUuid: "not-a-uuid" })).statusCode).toBe(400);
    expect(fields(await send({ seals: [{ sealNo: "A1", intact: true }], result: "PASS", photoFileIds: [999_999] }))).toEqual([{ field: "photoFileIds", message: "Foto 999999 tidak ditemukan." }]);
    // a photo already attached to a form is not attached again
    const used = await ctx.photo("satpam");
    expect((await ctx.form(await ctx.stepId(other.tripId, "SEAL_CHECK"), "seal-check", { seals: [{ sealNo: "B1", intact: true }], result: "PASS", photoFileIds: [used] }, "satpam")).statusCode).toBe(200);
    expect(fields(await send({ seals: [{ sealNo: "A1", intact: true }], result: "PASS", photoFileIds: [used] }))).toEqual([{ field: "photoFileIds", message: `Foto ${used} sudah dipakai.` }]);
    expect(await ctx.count("select count(*)::int as n from inspections where trip_id = $1", [truck.tripId])).toBe(0);
  });

  it("needs security_check at create level on a staff account", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    const body = { seals: [{ sealNo: "A1", intact: true }], result: "PASS" };
    expect((await ctx.form(id, "seal-check", body, "qcop")).statusCode).toBe(403);
    expect((await ctx.form(id, "seal-check", body, "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(id, "seal-check", body, "pks1")).statusCode).toBe(403);
    expect((await ctx.form(999_999, "seal-check", body, "satpam")).statusCode).toBe(404);
    expect(await statuses(ctx, truck.tripId)).toContain("SEAL_CHECK:READY");
  });

  it("refuses another kind of step and a step that is not ready", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const body = { seals: [{ sealNo: "A1", intact: true }], result: "PASS" };
    const wrong = await ctx.form(await ctx.stepId(truck.tripId, "QC"), "seal-check", body, "lapangan");
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toEqual({ code: "WRONG_STEP", message: "Form ini bukan untuk langkah QC pass." });
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    expect((await ctx.form(id, "seal-check", body, "satpam")).statusCode).toBe(200);
    const again = await ctx.form(id, "seal-check", body, "satpam");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NOT_READY");
  });

  it("answers a resend with the same uuid with what was stored, without saving twice", async () => {
    const ctx = await fieldApp();
    const truck = await ctx.incoming();
    const id = await ctx.stepId(truck.tripId, "SEAL_CHECK");
    const body = { clientUuid: randomUUID(), seals: [{ sealNo: "A1", intact: true }], result: "PASS" };
    const first = await ctx.form(id, "seal-check", body, "satpam");
    ctx.clock.advance(5_000);
    const second = await ctx.form(id, "seal-check", body, "satpam");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from inspections where trip_id = $1", [truck.tripId])).toBe(1);
    expect(await ctx.count("select count(*)::int as n from audit_log where action = 'FORM_SEAL_CHECK'")).toBe(1);
    // the same uuid for another step is a mistake of the phone
    const other = await ctx.incoming();
    const reused = await ctx.form(await ctx.stepId(other.tripId, "SEAL_CHECK"), "seal-check", body, "satpam");
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("UUID_REUSED");
  });
});

describe("qc-receiving", () => {
  it("OK records the check and its values, finishes the step and makes unloading ready", async () => {
    const ctx = await fieldApp();
    const truck = await atQc(ctx);
    const id = await ctx.stepId(truck.tripId, "QC");
    const response = await ctx.form(id, "qc-receiving", qcBody({ remark: "Sampel jernih" }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { id, status: "DONE", result: "PASS" }, trip: { currentStep: "UNLOADING" }, next: { stepCode: "UNLOADING", status: "READY" }, exception: null });
    const [check] = await ctx.database.query<Record<string, unknown>>(
      "select id::int as id, stage, disposition, reason_code, decision, remark, (decided_by = sampled_by) as same, trip_step_id::int as trip_step_id from quality_checks where trip_id = $1",
      [truck.tripId],
    );
    expect(check).toMatchObject({ stage: "RECEIVING", disposition: "OK", reason_code: null, decision: "PASS", remark: "Sampel jernih", same: true, trip_step_id: id });
    expect(await ctx.database.query("select parameter_code, value::text as value, source from quality_values where quality_check_id = $1 order by parameter_code", [check?.id])).toEqual([
      { parameter_code: "FFA", value: "3.2500", source: "QC" },
      { parameter_code: "IMPURITIES", value: "0.0200", source: "QC" },
      { parameter_code: "MOISTURE", value: "0.1200", source: "QC" },
    ]);
    expect(await ctx.count("select count(*)::int as n from exceptions where trip_id = $1", [truck.tripId])).toBe(0);
  });

  it("refuses values outside the plausibility range field by field, and checks the reason against the disposition", async () => {
    const ctx = await fieldApp();
    const truck = await atQc(ctx);
    const id = await ctx.stepId(truck.tripId, "QC");
    const send = (body: Body) => ctx.form(id, "qc-receiving", body, "qcop");
    expect(fields(await send(qcBody({ values: { FFA: 25, MOISTURE: 0.1, IMPURITIES: 5.5 } })))).toEqual([
      { field: "values.FFA", message: "FFA harus antara 0 dan 20." },
      { field: "values.IMPURITIES", message: "Impurities (kotoran) harus antara 0 dan 5." },
    ]);
    expect(fields(await send(qcBody({ values: { FFA: 3 } })))).toEqual([{ field: "values.MOISTURE", message: "MOISTURE wajib diisi." }]);
    expect(fields(await send(qcBody({ values: { FFA: -1, MOISTURE: 0.1 } })))).toEqual([{ field: "values.FFA", message: "FFA tidak boleh negatif." }]);
    expect(fields(await send(holdBody({ reasonCode: undefined })))).toEqual([{ field: "reasonCode", message: "Keterangan wajib dipilih bila disposisi bukan OK." }]);
    expect(fields(await send(qcBody({ reasonCode: "MI_OUT" })))).toEqual([{ field: "reasonCode", message: "Keterangan hanya diisi bila disposisi bukan OK." }]);
    expect((await send(holdBody({ reasonCode: "TOO_HOT" }))).statusCode).toBe(400);
    expect((await send(qcBody({ disposition: "MAYBE" }))).statusCode).toBe(400);
    expect(await ctx.count("select count(*)::int as n from quality_checks where trip_id = $1", [truck.tripId])).toBe(0);
  });

  it("HOLD keeps the truck at QC and asks the QC supervisors for a decision", async () => {
    const ctx = await fieldApp();
    const truck = await atQc(ctx);
    const id = await ctx.stepId(truck.tripId, "QC");
    const response = await ctx.form(id, "qc-receiving", holdBody({ remark: "FFA tinggi" }), "qcop");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { status: "IN_PROGRESS", result: "HOLD" }, trip: { currentStep: "QC" }, next: null, exception: { id: expect.any(Number), type: "QC_HOLD" } });
    const [exception] = await ctx.database.query<Record<string, unknown>>(
      "select type, status, approver_module, station_id, trip_step_id::int as trip_step_id, (quality_check_id is not null) as has_check from exceptions where trip_id = $1",
      [truck.tripId],
    );
    expect(exception).toEqual({ type: "QC_HOLD", status: "PENDING", approver_module: "qc_approvals", station_id: null, trip_step_id: id, has_check: true });
    expect(await ctx.database.query("select disposition, reason_code, decision, decided_by from quality_checks where trip_id = $1", [truck.tripId])).toEqual([
      { disposition: "HOLD", reason_code: "FFA_OUT", decision: "HOLD", decided_by: null },
    ]);
    // nothing moves on while it waits
    expect((await ctx.form(id, "qc-receiving", qcBody(), "qcop")).json().error.code).toBe("NOT_READY");
    expect((await ctx.call("POST", `/api/trips/${truck.tripId}/steps/QC/complete`, "lapangan", { result: "PASS" })).json().error.code).toBe("NOT_READY");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 10_000, plateRead: truck.plateNo })).json().error.code).toBe("NOT_READY");
    // the work list still shows the held step
    expect((await ctx.call("GET", "/api/work/steps", "qcop")).json().items).toEqual([expect.objectContaining({ id, status: "IN_PROGRESS", result: "HOLD" })]);
  });

  it("NOT_OK also asks for a decision", async () => {
    const ctx = await fieldApp();
    const { truck } = await held(ctx, holdBody({ disposition: "NOT_OK", reasonCode: "MI_OUT" }));
    expect(await ctx.database.query("select disposition, reason_code, decision from quality_checks where trip_id = $1", [truck.tripId])).toEqual([{ disposition: "NOT_OK", reason_code: "MI_OUT", decision: "HOLD" }]);
    expect(await ctx.database.query("select type, status from exceptions where trip_id = $1", [truck.tripId])).toEqual([{ type: "QC_HOLD", status: "PENDING" }]);
  });

  it("needs qc at create level, refuses the QC of incoming goods and a step that is not ready, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const truck = await atQc(ctx);
    const id = await ctx.stepId(truck.tripId, "QC");
    expect((await ctx.form(id, "qc-receiving", qcBody(), "satpam")).statusCode).toBe(403);
    expect((await ctx.form(id, "qc-receiving", qcBody(), "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(id, "qc-receiving", qcBody(), "pks1")).statusCode).toBe(403);

    const goods = await ctx.incoming({ product: "olein" });
    await ctx.forceReady(goods.tripId, "QC");
    const wrong = await ctx.form(await ctx.stepId(goods.tripId, "QC"), "qc-receiving", qcBody(), "qcop");
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("WRONG_STEP");
    expect((await ctx.form(await ctx.stepId(truck.tripId, "UNLOADING"), "qc-receiving", qcBody(), "lapangan")).json().error.code).toBe("WRONG_STEP");

    const body = qcBody({ clientUuid: randomUUID() });
    const first = await ctx.form(id, "qc-receiving", body, "qcop");
    const second = await ctx.form(id, "qc-receiving", body, "qcop");
    expect(second.json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from quality_checks where trip_id = $1", [truck.tripId])).toBe(1);
    expect((await ctx.form(id, "qc-receiving", qcBody(), "qcop")).json().error.code).toBe("NOT_READY");
  });
});

describe("the decision of a QC hold", () => {
  it("approved by a QC supervisor: QC is done and unloading is ready", async () => {
    const ctx = await fieldApp();
    const { truck, exceptionId } = await held(ctx);
    const decided = await ctx.call("POST", `/api/exceptions/${exceptionId}/decide`, "qcspv", { decision: "APPROVE", reason: "Masih bisa diolah" });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().exception).toMatchObject({ id: exceptionId, type: "QC_HOLD", status: "APPROVED", decision: "APPROVE", reason: "Masih bisa diolah", decidedBy: { fullName: "Staff qcspv" } });
    const [check] = await ctx.database.query<{ decision: string; decider: string }>(
      "select q.decision, u.username as decider from quality_checks q join users u on u.id = q.decided_by where q.trip_id = $1",
      [truck.tripId],
    );
    expect(check).toEqual({ decision: "PASS", decider: "qcspv" });
    expect(await statuses(ctx, truck.tripId)).toEqual(expect.arrayContaining(["QC:DONE/PASS", "UNLOADING:READY"]));
    expect((await ctx.tripRow(truck.tripId))?.current_step).toBe("UNLOADING");
    const again = await ctx.call("POST", `/api/exceptions/${exceptionId}/decide`, "qcspv", { decision: "REJECT" });
    expect(again.json().error.code).toBe("ALREADY_DECIDED");
  });

  it("rejected: the truck is rejected for its spec, the reseal is ready and unloading is skipped", async () => {
    const ctx = await fieldApp();
    const truck = await rejected(ctx);
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ outcome: "SPEC_REJECT", current_step: "RESEAL", status: "IN_PROCESS" });
    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE/PASS", "SEAL_CHECK:DONE/PASS", "WEIGH_1:DONE/PASS", "QC:FAILED/FAIL", "UNLOADING:SKIPPED", "TANK_CHECK:SKIPPED", "RESEAL:READY", "WEIGH_2:PENDING", "CHECK_OUT:PENDING",
    ]);
    expect(await ctx.database.query("select decision from quality_checks where trip_id = $1", [truck.tripId])).toEqual([{ decision: "REJECT" }]);
  });

  it("only holders of qc_approvals at edit level decide it, with a remark of at most 300 characters", async () => {
    const ctx = await fieldApp();
    const { exceptionId } = await held(ctx);
    const decide = (as: string, body: Body) => ctx.call("POST", `/api/exceptions/${exceptionId}/decide`, as, body);
    expect((await decide("atasan", { decision: "APPROVE" })).statusCode).toBe(403);
    await ctx.seed.seedStaff(ctx.database, "qclihatspv", { qc_approvals: "VIEW" });
    expect((await decide("qclihatspv", { decision: "APPROVE" })).statusCode).toBe(403);
    expect(fields(await decide("qcspv", { decision: "APPROVE", reason: "x".repeat(301) }))).toEqual([{ field: "reason", message: "Catatan keputusan paling banyak 300 huruf." }]);
    expect(fields(await decide("qcspv", { decision: "ADD_LOAD" }))).toEqual([{ field: "decision", message: "Keputusan harus APPROVE atau REJECT." }]);
    expect((await decide("qcspv", { decision: "APPROVE", updateMasterTare: true })).statusCode).toBe(400);

    // a QC supervisor cannot decide a weighbridge request
    const plate = await ctx.incoming();
    await ctx.forceReady(plate.tripId, "WEIGH_1");
    const pending = (await ctx.weigh(ctx.wbIn.key, { cardUid: plate.cardUid, weightKg: 30_000, plateRead: "XX1" })).json();
    expect(pending.exception.type).toBe("PLATE");
    expect((await ctx.call("POST", `/api/exceptions/${pending.exception.id}/decide`, "qcspv", { decision: "APPROVE" })).statusCode).toBe(403);
  });

  it("is listed to QC supervisors only, never expires without a heartbeat, and is out of reach of the weighbridge", async () => {
    const ctx = await fieldApp();
    const { exceptionId } = await held(ctx);
    const plate = await ctx.incoming();
    await ctx.forceReady(plate.tripId, "WEIGH_1");
    const weighbridgeId = (await ctx.weigh(ctx.wbIn.key, { cardUid: plate.cardUid, weightKg: 30_000, plateRead: "XX1" })).json().exception.id;

    const listed = (as: string) => ctx.call("GET", "/api/exceptions", as);
    expect((await listed("qcspv")).json().items.map((item: { id: number }) => item.id)).toEqual([exceptionId]);
    expect((await listed("atasan")).json().items.map((item: { id: number }) => item.id)).toEqual([weighbridgeId]);
    await ctx.seed.seedStaff(ctx.database, "keduanya", { approvals: "VIEW", qc_approvals: "VIEW" });
    expect((await listed("keduanya")).json().items.map((item: { id: number }) => item.id).sort()).toEqual([exceptionId, weighbridgeId].sort());
    expect((await ctx.call("GET", `/api/exceptions?type=QC_HOLD`, "atasan")).json().items).toEqual([]);

    const one = await ctx.call("GET", `/api/exceptions/${exceptionId}`, "qcspv");
    expect(one.statusCode).toBe(200);
    expect(one.json().exception).toMatchObject({ type: "QC_HOLD", status: "PENDING", qualityCheckId: expect.any(Number), context: { disposition: "HOLD", reasonCode: "FFA_OUT", values: { FFA: 6.1, MOISTURE: 0.12 } } });
    expect((await ctx.call("GET", `/api/exceptions/${exceptionId}`, "atasan")).statusCode).toBe(404);
    expect((await ctx.call("GET", `/api/exceptions/${weighbridgeId}`, "qcspv")).statusCode).toBe(404);

    // a minute without a heartbeat: the weighbridge request is cancelled, the QC hold waits
    ctx.clock.advance(60_000);
    expect((await listed("keduanya")).json().items.map((item: { id: number; status: string }) => `${item.id}:${item.status}`).sort()).toEqual(
      [`${exceptionId}:PENDING`, `${weighbridgeId}:CANCELLED`].sort(),
    );
    expect((await ctx.station(ctx.wbIn.key, "POST", `/api/weighbridge/exceptions/${exceptionId}/cancel`, { reason: "TRUCK_LEFT" })).statusCode).toBe(404);
    expect((await ctx.station(ctx.wbIn.key, "POST", `/api/weighbridge/exceptions/${exceptionId}/heartbeat`, { weightKg: 0 })).statusCode).toBe(404);
    expect(await ctx.database.query("select status from exceptions where id = $1", [exceptionId])).toEqual([{ status: "PENDING" }]);
  });
});

describe("reseal", () => {
  it("puts stock seals on the rejected truck, uses them up, issues the out-spec letter and makes the weighing out ready", async () => {
    const ctx = await fieldApp();
    const truck = await rejected(ctx);
    const id = await ctx.stepId(truck.tripId, "RESEAL");
    const [s1, s2] = ctx.seals;
    const response = await ctx.form(id, "reseal", { seals: [{ sealId: s1 }, { sealId: s2 }], remark: "Disegel kembali" }, "segel");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { status: "DONE", result: "PASS", note: "Disegel kembali" }, next: { stepCode: "WEIGH_2", status: "READY" } });
    expect(
      await ctx.database.query("select seal_no, origin, kind, seal_id::int as seal_id, trip_step_id::int as trip_step_id, applied_at is not null as applied from trip_seals where trip_id = $1 order by seal_no", [truck.tripId]),
    ).toEqual([
      { seal_no: "LC-0001", origin: "APPLIED", kind: "LOCIS", seal_id: s1, trip_step_id: id, applied: true },
      { seal_no: "LC-0002", origin: "APPLIED", kind: "LOCIS", seal_id: s2, trip_step_id: id, applied: true },
    ]);
    expect(await ctx.database.query("select status from seals where id in ($1, $2) order by id", [s1, s2])).toEqual([{ status: "USED" }, { status: "USED" }]);
    expect(await ctx.database.query("select out_spec_letter_no from trips where id = $1", [truck.tripId])).toEqual([{ out_spec_letter_no: "0001/OS/SMK/XI/2026" }]);
    // the seals are on the truck now
    const form = (await ctx.call("GET", `/api/work/steps/${await ctx.stepId(truck.tripId, "CHECK_OUT")}`, "pos")).json().form;
    expect(form.sealsInPlace.map((seal: { sealNo: string }) => seal.sealNo)).toEqual(["LC-0001", "LC-0002"]);
  });

  it("takes one to four distinct available seals of the stock", async () => {
    const ctx = await fieldApp();
    const truck = await rejected(ctx);
    const id = await ctx.stepId(truck.tripId, "RESEAL");
    const [s1, s2, s3, s4, s5] = ctx.seals;
    const send = (seals: unknown[]) => ctx.form(id, "reseal", { seals }, "segel");
    expect(fields(await send([]))).toEqual([{ field: "seals", message: "Pilih 1 sampai 4 segel." }]);
    expect(fields(await send([s1, s2, s3, s4, s5].map((sealId) => ({ sealId }))))).toEqual([{ field: "seals", message: "Pilih 1 sampai 4 segel." }]);
    expect(fields(await send([{ sealId: s1 }, { sealId: s1 }]))).toEqual([{ field: "seals", message: "Segel yang sama dipilih dua kali." }]);
    expect(fields(await send([{ sealId: 999_999 }]))).toEqual([{ field: "seals.0.sealId", message: "Segel tidak ditemukan." }]);
    await ctx.database.query("update seals set status = 'VOID' where id = $1", [s2]);
    const voided = await send([{ sealId: s1 }, { sealId: s2 }]);
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error).toEqual({ code: "SEAL_NOT_AVAILABLE", message: "Segel LC-0002 sudah terpakai atau dibatalkan." });
    expect(await ctx.database.query("select status from seals where id = $1", [s1])).toEqual([{ status: "AVAILABLE" }]);
    expect(await ctx.count("select count(*)::int as n from trip_seals")).toBe(0);
  });

  it("needs sealing at create level, the right step in the right state, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const truck = await rejected(ctx);
    const id = await ctx.stepId(truck.tripId, "RESEAL");
    const body = { clientUuid: randomUUID(), seals: [{ sealId: ctx.seals[0] }] };
    expect((await ctx.form(id, "reseal", body, "qcop")).statusCode).toBe(403);
    expect((await ctx.form(id, "reseal", body, "qclihat")).statusCode).toBe(403);
    expect((await ctx.form(await ctx.stepId(truck.tripId, "QC"), "reseal", body, "lapangan")).json().error.code).toBe("WRONG_STEP");
    const first = await ctx.form(id, "reseal", body, "segel");
    expect(first.statusCode, first.body).toBe(200);
    expect((await ctx.form(id, "reseal", body, "segel")).json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from trip_seals")).toBe(1);
    expect(await ctx.database.query("select last_no from document_counters where counter_key like 'OS/%'")).toEqual([{ last_no: 1 }]);
    expect((await ctx.form(id, "reseal", { seals: [{ sealId: ctx.seals[1] }] }, "segel")).json().error.code).toBe("NOT_READY");
  });
});

describe("unloading", () => {
  const unloadBody = (ctx: FieldApp, extra: Body = {}): Body => ({
    tankId: ctx.tanks.cpo, doorNo: 3, wood: false, wire: false, plastic: true, handbrakeOn: true, engineOn: false, manholeOpen: true, dischargeValveActive: true, tankEmpty: true, ...extra,
  });
  const atUnloading = async (ctx: FieldApp) => {
    const truck = await atQc(ctx);
    await ctx.forceReady(truck.tripId, "UNLOADING");
    return { truck, id: await ctx.stepId(truck.tripId, "UNLOADING") };
  };

  it("records the log sheet with the tank and photos, and completes the tank check with it", async () => {
    const ctx = await fieldApp();
    const { truck, id } = await atUnloading(ctx);
    const photos = [await ctx.photo("bongkar"), await ctx.photo("bongkar")];
    const clientUuid = randomUUID();
    const response = await ctx.form(id, "unloading", unloadBody(ctx, { clientUuid, remark: "Ada plastik kecil", photoFileIds: photos }), "bongkar");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ step: { id, status: "DONE", result: "PASS" }, trip: { currentStep: "WEIGH_2" }, next: { stepCode: "WEIGH_2", status: "READY" } });
    const [handling] = await ctx.database.query<Record<string, unknown>>(
      "select kind, tank_id, trip_step_id::int as trip_step_id, log_sheet, remark, client_uuid::text as client_uuid, finished_at is not null as finished from handlings where trip_id = $1",
      [truck.tripId],
    );
    expect(handling).toEqual({
      kind: "UNLOAD",
      tank_id: ctx.tanks.cpo,
      trip_step_id: id,
      remark: "Ada plastik kecil",
      client_uuid: clientUuid,
      finished: true,
      log_sheet: { doorNo: 3, wood: false, wire: false, plastic: true, handbrakeOn: true, engineOn: false, manholeOpen: true, dischargeValveActive: true, tankEmpty: true },
    });
    const tankStep = await ctx.stepId(truck.tripId, "TANK_CHECK");
    expect(await ctx.database.query("select kind, result, trip_step_id::int as trip_step_id, checklist from inspections where trip_id = $1", [truck.tripId])).toEqual([
      { kind: "TANK_EMPTY", result: "PASS", trip_step_id: tankStep, checklist: [{ key: "tankEmpty", item: "Tangki truk kosong", ok: true }] },
    ]);
    expect(await statuses(ctx, truck.tripId)).toEqual(expect.arrayContaining(["UNLOADING:DONE/PASS", "TANK_CHECK:DONE/PASS", "RESEAL:SKIPPED", "WEIGH_2:READY"]));
    expect(await ctx.database.query("select file_id::int as file_id, step_code from trip_files where trip_id = $1 order by file_id", [truck.tripId])).toEqual(photos.map((file_id) => ({ file_id, step_code: "UNLOADING" })));
  });

  it("checks the tank, the door, the checks and the photos", async () => {
    const ctx = await fieldApp();
    const { id } = await atUnloading(ctx);
    const send = (extra: Body) => ctx.form(id, "unloading", unloadBody(ctx, extra), "bongkar");
    expect(fields(await send({ tankEmpty: false }))).toEqual([{ field: "tankEmpty", message: "Tangki truk harus kosong sebelum bongkar disimpan." }]);
    expect(fields(await send({ doorNo: 11 }))).toEqual([{ field: "doorNo", message: "Nomor pintu 1 sampai 10." }]);
    expect(fields(await send({ engineOn: undefined }))).toEqual([{ field: "engineOn", message: "Mesin wajib diisi." }]);
    expect(fields(await send({ tankId: ctx.tanks.olein }))).toEqual([{ field: "tankId", message: "Tangki ini bukan untuk produk truk ini." }]);
    await ctx.database.query("update storage_tanks set is_active = false where id = $1", [ctx.tanks.cpo2]);
    expect(fields(await send({ tankId: ctx.tanks.cpo2 }))).toEqual([{ field: "tankId", message: "Tangki tidak ditemukan atau tidak aktif." }]);
    const photos = [];
    for (let n = 0; n < 4; n++) photos.push(await ctx.photo("bongkar"));
    expect(fields(await send({ photoFileIds: photos }))).toEqual([{ field: "photoFileIds", message: "Paling banyak 3 foto." }]);
    expect(await ctx.count("select count(*)::int as n from handlings")).toBe(0);
  });

  it("needs unloading at create level, the unloading of incoming CPO, and stores a resend once", async () => {
    const ctx = await fieldApp();
    const { truck, id } = await atUnloading(ctx);
    expect((await ctx.form(id, "unloading", unloadBody(ctx), "qcop")).statusCode).toBe(403);
    expect((await ctx.form(id, "unloading", unloadBody(ctx), "qclihat")).statusCode).toBe(403);
    const goods = await ctx.incoming({ product: "olein" });
    await ctx.forceReady(goods.tripId, "UNLOADING");
    expect((await ctx.form(await ctx.stepId(goods.tripId, "UNLOADING"), "unloading", unloadBody(ctx), "bongkar")).json().error.code).toBe("WRONG_STEP");
    const body = unloadBody(ctx, { clientUuid: randomUUID() });
    const first = await ctx.form(id, "unloading", body, "bongkar");
    expect((await ctx.form(id, "unloading", body, "bongkar")).json()).toEqual(first.json());
    expect(await ctx.count("select count(*)::int as n from handlings where trip_id = $1", [truck.tripId])).toBe(1);
    expect(await ctx.count("select count(*)::int as n from inspections where trip_id = $1", [truck.tripId])).toBe(1);
    expect((await ctx.form(id, "unloading", unloadBody(ctx), "bongkar")).json().error.code).toBe("NOT_READY");
  });
});
