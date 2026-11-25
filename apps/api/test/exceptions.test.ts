// Exceptions: the five checks in order, one open request per trip and type, heartbeat and expiry, cancel, the
// decision table, the master tare, the report number and the report data.
import { describe, expect, it } from "vitest";
import { weighingApp } from "./helpers/weighing.js";

type App = Awaited<ReturnType<typeof weighingApp>>;
type Kind = "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT";

/** Brings a fresh truck to an open exception of the given type; answers the 202 body. */
async function raise(ctx: App, type: Kind) {
  const { weigh, wbIn, wbOut, incoming, outgoing, forceReady } = ctx;
  if (type === "PLATE" || type === "GROSS_IN" || type === "NET_IN") {
    const truck = await incoming({ contracts: [{ tolerancePct: 0.2, originNetKg: 20_000 }] });
    await forceReady(truck.tripId, "WEIGH_1");
    if (type === "PLATE") return { truck, key: wbIn.key, body: (await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: "BK1X" })).json() };
    if (type === "GROSS_IN") return { truck, key: wbIn.key, body: (await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 31_000, plateRead: truck.plateNo })).json() };
    expect((await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    await forceReady(truck.tripId, "WEIGH_2");
    return { truck, key: wbIn.key, body: (await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 9_000, plateRead: truck.plateNo })).json() };
  }
  const truck = await outgoing({ closeCargo: type === "NET_OUT" });
  if (type === "TARE_OUT") return { truck, key: wbOut.key, body: (await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 16_000, plateRead: truck.plateNo })).json() };
  expect((await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
  await forceReady(truck.tripId, "WEIGH_2");
  return { truck, key: wbOut.key, body: (await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 45_000, plateRead: truck.plateNo })).json() };
}

const heartbeat = (ctx: App, key: string, id: number, weightKg: number) => ctx.station(key, "POST", `/api/weighbridge/exceptions/${id}/heartbeat`, { weightKg });
const decide = (ctx: App, id: number, body: object) => ctx.call("POST", `/api/exceptions/${id}/decide`, "atasan", body);
const weighingCount = async (ctx: App, tripId: number) => Number((await ctx.database.query<{ n: number }>("select count(*)::int as n from weighings where trip_id = $1", [tripId]))[0]?.n);

describe("the checks", () => {
  it("answers PLATE_RETRY until the station's plate attempts are used, then raises PLATE and saves nothing", async () => {
    const ctx = await weighingApp({ plateAttempts: 2 });
    const truck = await ctx.incoming();
    await ctx.forceReady(truck.tripId, "WEIGH_1");
    const first = await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: "BK 1 X" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ result: "PLATE_RETRY", attemptsLeft: 1, message: "Plat belum terbaca sesuai. Coba baca plat lagi.", speech: ["Plat belum terbaca sesuai.", "Coba baca plat lagi."] });
    // the camera gave no text: also a mismatch
    const second = await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_000, plateRead: null });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      result: "PENDING",
      exception: { id: expect.any(Number), type: "PLATE" },
      speech: ["Plat tidak sesuai.", "Plat tidak terbaca.", expect.stringMatching(/^Terdaftar B K /), "Mohon tunggu keputusan atasan."],
    });
    expect(await weighingCount(ctx, truck.tripId)).toBe(0);
    // asking again returns the open request
    const again = await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 30_020, plateRead: truck.plateNo });
    expect(again.statusCode).toBe(202);
    expect(again.json().exception).toEqual(second.json().exception);
    expect(await ctx.database.query("select count(*)::int as n, max(live_weight_kg) as w from exceptions")).toEqual([{ n: 1, w: 30_020 }]);
  });

  it("checks the gross of an incoming truck against the smallest contract tolerance above zero, and not at all when all are zero", async () => {
    const ctx = await weighingApp();
    // a CPO truck carries at most two contracts; the zero-tolerance case is in weighing-rules.test.ts
    const tight = await ctx.incoming({ contracts: [{ tolerancePct: 0.5, originNetKg: 12_000 }, { tolerancePct: 0.2, originNetKg: 8_000 }] });
    await ctx.forceReady(tight.tripId, "WEIGH_1");
    // document gross 30 000; 0.2 % is 60 kg
    const over = await ctx.weigh(ctx.wbIn.key, { cardUid: tight.cardUid, weightKg: 30_061, plateRead: tight.plateNo });
    expect(over.statusCode).toBe(202);
    expect(over.json().exception.type).toBe("GROSS_IN");
    const [row] = await ctx.database.query<Record<string, string>>("select expected_value::int as e, actual_value::int as a, diff_value::int as d, diff_pct::text as p, tolerance_pct::text as t from exceptions");
    expect(row).toEqual({ e: 30_000, a: 30_061, d: 61, p: "0.2033", t: "0.2000" });
    await ctx.station(ctx.wbIn.key, "POST", `/api/weighbridge/exceptions/${over.json().exception.id}/cancel`, { reason: "OPERATOR" });
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: tight.cardUid, weightKg: 30_060, plateRead: tight.plateNo })).json().result).toBe("SAVED");

    const loose = await ctx.incoming({ contracts: [{ tolerancePct: 0, originNetKg: 20_000 }] });
    await ctx.forceReady(loose.tripId, "WEIGH_1");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: loose.cardUid, weightKg: 45_000, plateRead: loose.plateNo })).json().result).toBe("SAVED");
    // no figure on the letter: no check
    const noLetter = await ctx.incoming({ contracts: [{ tolerancePct: 0.2, originNetKg: null }] });
    await ctx.forceReady(noLetter.tripId, "WEIGH_1");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: noLetter.cardUid, weightKg: 45_000, plateRead: noLetter.plateNo })).json().result).toBe("SAVED");
  });

  it("checks the tare of an outgoing truck against the verified master tare, and always asks without one", async () => {
    const ctx = await weighingApp();
    const ok = await ctx.outgoing({ tareKg: 15_000 });
    expect((await ctx.weigh(ctx.wbOut.key, { cardUid: ok.cardUid, weightKg: 15_022, plateRead: ok.plateNo })).json().result).toBe("SAVED");
    const over = await ctx.outgoing({ tareKg: 15_000 });
    expect((await ctx.weigh(ctx.wbOut.key, { cardUid: over.cardUid, weightKg: 15_023, plateRead: over.plateNo })).json().exception.type).toBe("TARE_OUT");
    const noMaster = await ctx.outgoing({ tareKg: null });
    const asked = (await ctx.weigh(ctx.wbOut.key, { cardUid: noMaster.cardUid, weightKg: 15_000, plateRead: noMaster.plateNo })).json();
    expect(asked).toMatchObject({ exception: { type: "TARE_OUT" }, speech: ["Tarra master belum ada atau kendaraan belum diverifikasi.", "Timbang 15.000 kilogram.", "Mohon tunggu keputusan atasan."] });
    const unverified = await ctx.outgoing({ tareKg: 15_000, verified: false });
    expect((await ctx.weigh(ctx.wbOut.key, { cardUid: unverified.cardUid, weightKg: 15_000, plateRead: unverified.plateNo })).json().exception.type).toBe("TARE_OUT");
  });

  it("checks the net of an incoming truck at the second weighing, and asks for every close-cargo outgoing truck", async () => {
    const ctx = await weighingApp();
    const net = await raise(ctx, "NET_IN");
    expect(net.body).toMatchObject({ result: "PENDING", exception: { type: "NET_IN" }, message: "Selisih netto melewati toleransi. Netto 21.000 kg, surat 20.000 kg. Mohon tunggu keputusan atasan." });
    const out = await raise(ctx, "NET_OUT");
    expect(out.body).toMatchObject({ result: "PENDING", exception: { type: "NET_OUT" }, message: "Netto perlu diperiksa atasan. Netto 30.000 kg. Mohon tunggu keputusan atasan." });
    // an outgoing truck without close cargo or flexi bag is not asked
    const plain = await ctx.outgoing();
    await ctx.weigh(ctx.wbOut.key, { cardUid: plain.cardUid, weightKg: 15_000, plateRead: plain.plateNo });
    await ctx.forceReady(plain.tripId, "WEIGH_2");
    expect((await ctx.weigh(ctx.wbOut.key, { cardUid: plain.cardUid, weightKg: 45_000, plateRead: plain.plateNo })).json().result).toBe("SAVED");
  });

  it("checks the plate before the weight: a wrong plate and a wrong gross raise PLATE first", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming({ contracts: [{ tolerancePct: 0.2, originNetKg: 20_000 }] });
    await ctx.forceReady(truck.tripId, "WEIGH_1");
    expect((await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 39_000, plateRead: "B1Q" })).json().exception.type).toBe("PLATE");
  });
});

describe("heartbeat, expiry and cancel", () => {
  it("updates the live weight, expires after 10 seconds without a heartbeat and then refuses a decision", async () => {
    const ctx = await weighingApp();
    const { key, body } = await raise(ctx, "GROSS_IN");
    const id = body.exception.id;
    ctx.clock.advance(2_000);
    const beat = await heartbeat(ctx, key, id, 31_200);
    expect(beat.statusCode).toBe(200);
    expect(beat.json()).toEqual({ status: "PENDING", message: "Mohon tunggu keputusan atasan.", speech: ["Mohon tunggu keputusan atasan."] });
    expect(await ctx.database.query("select live_weight_kg, actual_value::int as a, diff_value::int as d from exceptions where id = $1", [id])).toEqual([{ live_weight_kg: 31_200, a: 31_200, d: 1_200 }]);
    // exactly 10 seconds is still alive
    ctx.clock.advance(10_000);
    expect((await heartbeat(ctx, key, id, 31_200)).json().status).toBe("PENDING");
    ctx.clock.advance(10_001);
    expect((await ctx.call("GET", `/api/exceptions/${id}`, "atasan")).json().exception).toMatchObject({ status: "CANCELLED", context: expect.objectContaining({ cancelReason: "TIMEOUT" }) });
    const late = await heartbeat(ctx, key, id, 31_200);
    expect(late.json()).toMatchObject({ status: "CANCELLED", result: "NOT_SAVED", message: "Permintaan dibatalkan. Truk belum menimbang." });
    const decided = await decide(ctx, id, { decision: "APPROVE", reason: "Sesuai surat jalan" });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error.code).toBe("EXCEPTION_CANCELLED");
  });

  it("cancels on request of the station only, and refuses to cancel a decided request", async () => {
    const ctx = await weighingApp();
    const { key, body, truck } = await raise(ctx, "GROSS_IN");
    const id = body.exception.id;
    expect((await ctx.station(ctx.wbOut.key, "POST", `/api/weighbridge/exceptions/${id}/heartbeat`, { weightKg: 1 })).statusCode).toBe(404);
    expect((await ctx.station(key, "POST", `/api/weighbridge/exceptions/${id}/cancel`, { reason: "NOPE" })).statusCode).toBe(400);
    const cancelled = await ctx.station(key, "POST", `/api/weighbridge/exceptions/${id}/cancel`, { reason: "TRUCK_LEFT" });
    expect(cancelled.json()).toEqual({ status: "CANCELLED", message: "Permintaan dibatalkan. Truk belum menimbang.", speech: ["Permintaan dibatalkan.", "Truk belum menimbang."] });
    expect((await decide(ctx, id, { decision: "APPROVE", reason: "Sesuai" })).json().error.code).toBe("EXCEPTION_CANCELLED");
    expect(await weighingCount(ctx, truck.tripId)).toBe(0);

    const next = (await ctx.weigh(key, { cardUid: truck.cardUid, weightKg: 31_000, plateRead: truck.plateNo })).json().exception.id;
    expect(next).not.toBe(id);
    expect((await decide(ctx, next, { decision: "HOLD", reason: "Muatan tidak sesuai" })).statusCode).toBe(200);
    const late = await ctx.station(key, "POST", `/api/weighbridge/exceptions/${next}/cancel`, { reason: "OPERATOR" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("ALREADY_DECIDED");
  });
});

describe("decisions", () => {
  const table: { type: Kind; decision: string; status: string; saved: boolean; report?: string }[] = [
    { type: "PLATE", decision: "APPROVE", status: "APPROVED", saved: true, report: "0001/BA-PLAT/SMK/XI/2026" },
    { type: "PLATE", decision: "HOLD", status: "REJECTED", saved: false },
    { type: "PLATE", decision: "REJECT", status: "REJECTED", saved: false },
    { type: "GROSS_IN", decision: "APPROVE", status: "APPROVED", saved: true, report: "0001/BA-SELISIH-BRUTO/SMK/XI/2026" },
    { type: "GROSS_IN", decision: "HOLD", status: "REJECTED", saved: false },
    { type: "GROSS_IN", decision: "REJECT", status: "REJECTED", saved: false },
    { type: "TARE_OUT", decision: "APPROVE", status: "APPROVED", saved: true, report: "0001/BA-SELISIH-TARRA/SMK/XI/2026" },
    { type: "TARE_OUT", decision: "HOLD", status: "REJECTED", saved: false },
    { type: "TARE_OUT", decision: "REJECT", status: "REJECTED", saved: false },
    { type: "NET_IN", decision: "APPROVE", status: "APPROVED", saved: true, report: "0001/BA-SELISIH-NETTO/SMK/XI/2026" },
    { type: "NET_IN", decision: "HOLD", status: "REJECTED", saved: false },
    { type: "NET_OUT", decision: "OK", status: "APPROVED", saved: true },
    { type: "NET_OUT", decision: "ADD_LOAD", status: "RETRY", saved: false },
    { type: "NET_OUT", decision: "REDUCE_LOAD", status: "RETRY", saved: false },
  ];

  it.each(table)("$type $decision: $status, weighing saved: $saved", async ({ type, decision, status, saved, report }) => {
    const ctx = await weighingApp();
    const { key, body, truck } = await raise(ctx, type);
    const id = body.exception.id;
    const before = await weighingCount(ctx, truck.tripId);
    // the figure saved is the last one the program sent
    await heartbeat(ctx, key, id, type === "TARE_OUT" ? 16_040 : type === "NET_IN" ? 9_010 : type === "NET_OUT" ? 45_020 : 30_040);
    const needsReason = ["GROSS_IN", "TARE_OUT", "NET_IN"].includes(type) || decision === "REJECT";
    const response = await decide(ctx, id, { decision, ...(needsReason ? { reason: "Sudah dicek dengan supir" } : {}) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().exception).toMatchObject({ id, type, status, decision, reportNo: report ?? null, options: [] });
    expect(await weighingCount(ctx, truck.tripId)).toBe(before + (saved ? 1 : 0));

    const answer = (await heartbeat(ctx, key, id, 1)).json();
    expect(answer.status).toBe(status);
    if (saved) {
      const expectedWeight = type === "TARE_OUT" ? 16_040 : type === "NET_IN" ? 9_010 : type === "NET_OUT" ? 45_020 : 30_040;
      expect(answer).toMatchObject({ result: "SAVED", weighing: { weightKg: expectedWeight, mode: "EXCEPTION", plateCheck: type === "PLATE" ? "CONFIRMED" : "MATCH" } });
      expect(answer.speech[0]).toBe("Permintaan disetujui.");
    } else if (decision === "REJECT") {
      // turned away before the first weighing: every step but the return of the card is skipped
      expect(answer).toMatchObject({ decision: "REJECT", result: "TRUCK_REJECTED", message: "Truk ditolak. Supir ke pos registrasi untuk mengembalikan kartu." });
      expect(await ctx.tripRow(truck.tripId)).toMatchObject({ outcome: "TRUCK_REJECT", current_step: "CHECK_OUT" });
      const steps = await ctx.steps(truck.tripId);
      expect(steps.find((step) => step.step_code === "WEIGH_1")?.status).toBe("FAILED");
      expect(steps.filter((step) => !["DONE", "FAILED", "SKIPPED"].includes(step.status)).map((step) => [step.step_code, step.status])).toEqual([["CHECK_OUT", "READY"]]);
    } else if (decision === "HOLD") {
      expect(answer).toMatchObject({ result: "NOT_SAVED", message: "Permintaan ditahan. Timbang tidak disimpan. Mundur dari timbangan." });
      expect(await ctx.tripRow(truck.tripId)).toMatchObject({ outcome: null });
    }
    if (status === "RETRY") {
      expect(answer.decision).toBe(decision);
      const steps = await ctx.steps(truck.tripId);
      expect(steps.filter((step) => ["LOADING", "SEALING", "WEIGH_2"].includes(step.step_code)).map((step) => [step.step_code, step.attempt, step.status])).toEqual([
        ["LOADING", 1, "DONE"], ["LOADING", 2, "READY"], ["SEALING", 1, "DONE"], ["SEALING", 2, "PENDING"], ["WEIGH_2", 1, "FAILED"], ["WEIGH_2", 2, "PENDING"],
      ]);
      expect((await ctx.tripRow(truck.tripId))?.current_step).toBe("LOADING");
    }
  });

  it("cancels every type without saving", async () => {
    for (const type of ["PLATE", "GROSS_IN", "TARE_OUT", "NET_IN", "NET_OUT"] as Kind[]) {
      const ctx = await weighingApp();
      const { key, body, truck } = await raise(ctx, type);
      const before = await weighingCount(ctx, truck.tripId);
      expect((await ctx.station(key, "POST", `/api/weighbridge/exceptions/${body.exception.id}/cancel`, { reason: "TRUCK_LEFT" })).json().status).toBe("CANCELLED");
      expect(await weighingCount(ctx, truck.tripId)).toBe(before);
    }
  });

  it("goes on with the next check after an approved plate", async () => {
    const ctx = await weighingApp();
    const truck = await ctx.incoming({ contracts: [{ tolerancePct: 0.2, originNetKg: 20_000 }] });
    await ctx.forceReady(truck.tripId, "WEIGH_1");
    const plate = (await ctx.weigh(ctx.wbIn.key, { cardUid: truck.cardUid, weightKg: 31_000, plateRead: "B1Q" })).json().exception;
    const decided = (await decide(ctx, plate.id, { decision: "APPROVE" })).json();
    expect(decided.next).toEqual({ id: expect.any(Number), type: "GROSS_IN" });
    const answer = (await heartbeat(ctx, ctx.wbIn.key, plate.id, 31_000)).json();
    expect(answer).toMatchObject({ status: "APPROVED", decision: "APPROVE", result: "PENDING", exception: decided.next });
    expect(await weighingCount(ctx, truck.tripId)).toBe(0);
    await heartbeat(ctx, ctx.wbIn.key, decided.next.id, 31_000);
    expect((await decide(ctx, decided.next.id, { decision: "APPROVE", reason: "Surat salah tulis" })).json().weighing).toMatchObject({ weightKg: 31_000, plateCheck: "CONFIRMED", mode: "EXCEPTION" });
  });

  it("makes the approved tare the master tare when asked, with a history row", async () => {
    const ctx = await weighingApp();
    const { key, body, truck } = await raise(ctx, "TARE_OUT");
    await heartbeat(ctx, key, body.exception.id, 16_010);
    const response = (await decide(ctx, body.exception.id, { decision: "APPROVE", reason: "Ganti ban baru", updateMasterTare: true })).json();
    expect(await ctx.database.query("select tare_kg from vehicles where id = $1", [truck.vehicleId])).toEqual([{ tare_kg: 16_010 }]);
    expect(await ctx.database.query("select tare_kg, source, weighing_id::int as weighing_id, reason from vehicle_tare_history where vehicle_id = $1", [truck.vehicleId])).toEqual([
      { tare_kg: 16_010, source: "WEIGHING", weighing_id: response.weighing.id, reason: "Ganti ban baru" },
    ]);
  });

  it("refuses a missing reason, a decision of the wrong kind, a master tare outside TARE_OUT, and a second decision", async () => {
    const ctx = await weighingApp();
    const { body } = await raise(ctx, "GROSS_IN");
    const id = body.exception.id;
    const noReason = await decide(ctx, id, { decision: "APPROVE", reason: " a " });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.fields).toEqual([{ field: "reason", message: "Alasan wajib diisi, minimal 3 huruf." }]);
    expect((await decide(ctx, id, { decision: "OK", reason: "Sesuai" })).json().error.fields).toEqual([{ field: "decision", message: "Keputusan harus APPROVE, HOLD atau REJECT." }]);
    expect((await decide(ctx, id, { decision: "APPROVE", reason: "Sesuai", updateMasterTare: true })).json().error.fields).toEqual([
      { field: "updateMasterTare", message: "Tarra master hanya bisa diganti pada selisih tarra yang disetujui." },
    ]);
    expect((await decide(ctx, id, { decision: "APPROVE", reason: "Sesuai" })).statusCode).toBe(200);
    const again = await decide(ctx, id, { decision: "REJECT", reason: "Sesuai" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_DECIDED");
    expect((await decide(ctx, 999_999, { decision: "APPROVE" })).statusCode).toBe(404);
  });
});

describe("decisions after the first weighing", () => {
  it("offers no reject on a net difference, nor on a plate at the second weighing", async () => {
    const ctx = await weighingApp();
    const net = await raise(ctx, "NET_IN");
    const shown = (await ctx.call("GET", `/api/exceptions/${net.body.exception.id}`, "atasan")).json().exception;
    expect(shown.options).toEqual(["APPROVE", "HOLD"]);
    const refused = await decide(ctx, net.body.exception.id, { decision: "REJECT", reason: "Selisih besar" });
    expect(refused.json().error.fields).toEqual([{ field: "decision", message: "Keputusan harus APPROVE atau HOLD." }]);
    const plate = await raise(ctx, "PLATE");
    expect((await ctx.call("GET", `/api/exceptions/${plate.body.exception.id}`, "atasan")).json().exception.options).toEqual(["APPROVE", "HOLD", "REJECT"]);
  });

  it("needs a reason to turn a truck away", async () => {
    const ctx = await weighingApp();
    const { body } = await raise(ctx, "PLATE");
    const response = await decide(ctx, body.exception.id, { decision: "REJECT" });
    expect(response.json().error.fields).toEqual([{ field: "reason", message: "Alasan wajib diisi, minimal 3 huruf." }]);
  });
});

describe("GET /api/exceptions", () => {
  it("lists with the figures, the plates and the station, filters by status and type, and gives the report data", async () => {
    const ctx = await weighingApp();
    const gross = await raise(ctx, "GROSS_IN");
    const plate = await raise(ctx, "PLATE");
    const list = (await ctx.call("GET", "/api/exceptions?status=PENDING", "atasan")).json();
    expect(list.items.map((item: { type: string }) => item.type)).toEqual(["PLATE", "GROSS_IN"]);
    expect(list.items[1]).toMatchObject({
      id: gross.body.exception.id,
      type: "GROSS_IN",
      status: "PENDING",
      expectedValue: 30_000,
      actualValue: 31_000,
      liveWeightKg: 31_000,
      diffValue: 1_000,
      tolerancePct: 0.2,
      plateNo: gross.truck.plateNo,
      station: { code: "WB-IN" },
      trip: { id: gross.truck.tripId },
    });
    expect(list.items[0]).toMatchObject({ plateRead: "BK1X", plateNo: plate.truck.plateNo });
    expect((await ctx.call("GET", "/api/exceptions?type=PLATE", "atasan")).json().items).toHaveLength(1);
    expect((await ctx.call("GET", "/api/exceptions?status=NOPE", "atasan")).statusCode).toBe(400);

    expect((await ctx.call("GET", `/api/exceptions/${plate.body.exception.id}/report`, "atasan")).json().error.code).toBe("NO_REPORT");
    await decide(ctx, gross.body.exception.id, { decision: "APPROVE", reason: "Surat salah tulis" });
    const report = (await ctx.call("GET", `/api/exceptions/${gross.body.exception.id}/report`, "atasan")).json().report;
    expect(report).toMatchObject({
      reportNo: "0001/BA-SELISIH-BRUTO/SMK/XI/2026",
      title: "Berita Acara Selisih Bruto",
      expectedKg: 30_000,
      weighedKg: 31_000,
      diffKg: 1_000,
      tolerancePct: 0.2,
      reason: "Surat salah tulis",
      decidedBy: { fullName: "Staff atasan" },
      trip: { id: gross.truck.tripId, plateNo: gross.truck.plateNo },
      station: { code: "WB-IN" },
    });
    expect(report.lines).toHaveLength(1);
    // signed by the operator who checked the truck in and by the approver
    expect(report.signers).toEqual([
      { role: "REGISTRAR", title: "Dibuat oleh", position: "Operator registrasi", user: { id: expect.any(Number), fullName: expect.any(String) } },
      { role: "APPROVER", title: "Disetujui oleh", position: "Penyetuju", user: { id: expect.any(Number), fullName: "Staff atasan" } },
    ]);

    await decide(ctx, plate.body.exception.id, { decision: "APPROVE" });
    const plateReport = (await ctx.call("GET", `/api/exceptions/${plate.body.exception.id}/report`, "atasan")).json().report;
    expect(plateReport).toMatchObject({ reportNo: "0001/BA-PLAT/SMK/XI/2026", title: "Berita Acara Plat Tidak Sesuai", plate: { read: "BK1X", registered: expect.any(String) } });
  });
});
