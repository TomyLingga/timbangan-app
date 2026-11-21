// Field steps in their simple form (done or rejected, with a note), the rejection rule, and the card return.
import { describe, expect, it } from "vitest";
import { weighingApp } from "./helpers/weighing.js";

type App = Awaited<ReturnType<typeof weighingApp>>;
const complete = (ctx: App, tripId: number, stepCode: string, body: object, as = "lapangan") => ctx.call("POST", `/api/trips/${tripId}/steps/${stepCode}/complete`, as, body);
const checkOut = (ctx: App, cardUid: string, as = "pos") => ctx.call("POST", "/api/gate/check-out", as, { cardUid });
const statuses = async (ctx: App, tripId: number) => (await ctx.steps(tripId)).map((step) => `${step.step_code}${step.attempt > 1 ? `#${step.attempt}` : ""}:${step.status}`);

describe("field steps", () => {
  it("completes the READY step with the holder of its module, moves on, and lists the steps with the weighings", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming();
    const done = await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "PASS", note: "Segel utuh" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().trip).toMatchObject({ id: truck.tripId, currentStep: "WEIGH_1" });
    const [row] = await ctx.database.query<{ status: string; result: string; note: string; performed_by: number }>("select status, result, note, performed_by::int as performed_by from trip_steps where trip_id = $1 and step_code = 'SEAL_CHECK'", [truck.tripId]);
    expect(row).toMatchObject({ status: "DONE", result: "PASS", note: "Segel utuh" });

    await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo });
    const listed = (await ctx.call("GET", `/api/trips/${truck.tripId}/steps`, "pos")).json();
    expect(listed.steps.map((step: { stepCode: string; status: string }) => [step.stepCode, step.status]).slice(0, 4)).toEqual([
      ["CHECK_IN", "DONE"], ["SEAL_CHECK", "DONE"], ["WEIGH_1", "DONE"], ["QC", "READY"],
    ]);
    expect(listed.steps[3]).toMatchObject({ name: "QC pass", performerModule: "qc", attempt: 1 });
    expect(listed.weighings).toEqual([expect.objectContaining({ stage: 1, kind: "GROSS", weightKg: 30_000 })]);
    expect(listed.trip).toMatchObject({ grossKg: 30_000 });
  });

  it("refuses a step that is not READY, a weighing step, the card return step, and an account without the step's module", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming();
    const early = await complete(ctx, truck.tripId, "QC", { result: "PASS" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("NOT_READY");
    expect((await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "PASS" }, "atasan")).statusCode).toBe(403);
    await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "PASS" });
    expect((await complete(ctx, truck.tripId, "WEIGH_1", { result: "PASS" })).json().error.code).toBe("STEP_AT_WEIGHBRIDGE");
    expect((await complete(ctx, truck.tripId, "CHECK_OUT", { result: "PASS" })).json().error.code).toBe("USE_CHECK_OUT");
    expect((await complete(ctx, truck.tripId, "NOPE", { result: "PASS" })).statusCode).toBe(404);
    expect((await complete(ctx, 999_999, "QC", { result: "PASS" })).statusCode).toBe(404);
    expect((await complete(ctx, truck.tripId, "QC", { result: "MAYBE" })).statusCode).toBe(400);
  });

  it("records the counted quantity of a non-kilogram DO at loading, and keeps it after the split", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.outgoing({ product: "packed", dos: [800] });
    await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo });
    expect((await complete(ctx, truck.tripId, "CLEANLINESS", { result: "PASS" })).statusCode).toBe(200);
    expect((await complete(ctx, truck.tripId, "LOADING", { result: "PASS", qtyActual: [{ seq: 2, qty: 1 }] })).json().error.fields).toEqual([
      { field: "qtyActual", message: "Alokasi 2 tidak ada pada truk ini." },
    ]);
    expect((await complete(ctx, truck.tripId, "LOADING", { result: "PASS", qtyActual: [{ seq: 1, qty: 790 }] })).statusCode).toBe(200);
    await complete(ctx, truck.tripId, "SEALING", { result: "PASS" });
    await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 23_000, plateRead: truck.plateNo });
    expect(await ctx.allocations(truck.tripId)).toEqual([{ seq: 1, net_kg: 8_000, qty_actual: "790.000", split_method: "SINGLE" }]);
  });
});

describe("rejection and card return", () => {
  it("an incoming truck rejected at QC: reseal and second weighing still run, the rest is skipped, the card comes back REJECTED", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming();
    await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "PASS" });
    await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo });
    // the card cannot come back before the exit step
    const early = await checkOut(ctx, truck.cardUid);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: "NOT_READY", message: "Truk belum sampai langkah keluar. Langkah sekarang: QC pass." });

    const rejected = await complete(ctx, truck.tripId, "QC", { result: "FAIL", note: "FFA terlalu tinggi" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().trip).toMatchObject({ outcome: "SPEC_REJECT", status: "IN_PROCESS", currentStep: "RESEAL" });
    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "SEAL_CHECK:DONE", "WEIGH_1:DONE", "QC:FAILED", "UNLOADING:SKIPPED", "TANK_CHECK:SKIPPED", "RESEAL:READY", "WEIGH_2:PENDING", "CHECK_OUT:PENDING",
    ]);
    await complete(ctx, truck.tripId, "RESEAL", { result: "PASS" });
    // it leaves loaded: no net check, no split
    const out = (await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 29_990, plateRead: truck.plateNo })).json();
    expect(out).toMatchObject({ result: "SAVED", trip: { netKg: 10, currentStep: "CHECK_OUT" } });
    expect((await ctx.allocations(truck.tripId))[0]).toMatchObject({ net_kg: null, split_method: null });

    const back = await checkOut(ctx, truck.cardUid);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().trip).toMatchObject({ status: "REJECTED", card: null });
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "REJECTED", outcome: "SPEC_REJECT", current_step: null, exited_at: new Date("2026-11-20T03:00:00.000Z") });
    expect(await ctx.database.query("select status from rfid_cards where uid = $1", [truck.cardUid])).toEqual([{ status: "AVAILABLE" }]);
    expect(await ctx.database.query("select release_reason from card_assignments where trip_id = $1", [truck.tripId])).toEqual([{ release_reason: "CHECK_OUT" }]);
    // the card is free: a second return finds no truck
    expect((await checkOut(ctx, truck.cardUid)).json().error.code).toBe("CARD_NOT_IN_USE");
  });

  it("an outgoing truck rejected at the cleanliness check goes straight to the exit", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.outgoing();
    await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo });
    const rejected = await complete(ctx, truck.tripId, "CLEANLINESS", { result: "FAIL", note: "Tangki kotor" });
    expect(rejected.json().trip).toMatchObject({ outcome: "TRUCK_REJECT", currentStep: "CHECK_OUT" });
    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "WEIGH_1:DONE", "CLEANLINESS:FAILED", "QC_LOADING:SKIPPED", "LOADING:SKIPPED", "SEALING:SKIPPED", "WEIGH_2:SKIPPED", "CHECK_OUT:READY",
    ]);
    const back = await checkOut(ctx, truck.cardUid);
    expect(back.json().trip).toMatchObject({ status: "REJECTED" });
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "REJECTED", outcome: "TRUCK_REJECT", tare_kg: 15_000, net_kg: null });
  });

  it("an incoming truck rejected at the seal check before its first weighing skips the second weighing too", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming();
    await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "FAIL", note: "Segel rusak" });
    expect(await statuses(ctx, truck.tripId)).toEqual([
      "CHECK_IN:DONE", "SEAL_CHECK:FAILED", "WEIGH_1:SKIPPED", "QC:SKIPPED", "UNLOADING:SKIPPED", "TANK_CHECK:SKIPPED", "RESEAL:READY", "WEIGH_2:SKIPPED", "CHECK_OUT:PENDING",
    ]);
  });

  it("returns the card of a completed truck: COMPLETED with outcome OK", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.outgoing();
    await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo });
    await ctx.forceReady(truck.tripId, "WEIGH_2");
    await ctx.weigh(ctx.wbOut.key, { cardUid: truck.cardUid, weightKg: 45_000, plateRead: truck.plateNo });
    expect((await checkOut(ctx, "ffff0000")).json().error.code).toBe("CARD_UNKNOWN");
    const back = await checkOut(ctx, truck.cardUid.toLowerCase());
    expect(back.statusCode).toBe(200);
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "COMPLETED", outcome: "OK", current_step: null });
    expect((await ctx.steps(truck.tripId)).at(-1)).toMatchObject({ step_code: "CHECK_OUT", status: "DONE" });
  });
});
