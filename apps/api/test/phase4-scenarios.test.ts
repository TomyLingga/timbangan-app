// The two journeys phase 4 has to carry, through the HTTP routes only, from check-in to the returned card.
import { describe, expect, it } from "vitest";
import { weighingApp } from "./helpers/weighing.js";

type App = Awaited<ReturnType<typeof weighingApp>>;
const complete = async (ctx: App, tripId: number, stepCode: string, body: object = { result: "PASS" }) => {
  const response = await ctx.call("POST", `/api/trips/${tripId}/steps/${stepCode}/complete`, "lapangan", body);
  expect(response.statusCode, `${stepCode}: ${response.body}`).toBe(200);
  return response.json();
};

describe("phase 4 scenarios", () => {
  it("(a) an incoming truck with two contracts: gross difference approved with a reason, split by origin nets, card returned, in the contract report", async () => {
    const ctx = await weighingApp();
    const { station, weigh, wbIn, call, clock } = ctx;
    const truck = await ctx.incoming({ plate: "BK 9101 AA", contracts: [{ tolerancePct: 0.5, originNetKg: 20_000 }, { tolerancePct: 0.2, originNetKg: 11_000 }] });

    // security checks the seal, then the weighbridge reads the card
    await complete(ctx, truck.tripId, "SEAL_CHECK", { result: "PASS", note: "Segel utuh" });
    const card = (await station(wbIn.key, "GET", `/api/weighbridge/card/${truck.cardUid}`)).json();
    expect(card).toMatchObject({ stage: 1, kind: "GROSS", camera: 3, expected: { plateNo: "BK9101AA", docGrossKg: 41_000 } });

    // 41 500 kg against 41 000 on the letters is past the 0.2 % of the tighter contract
    const pending = await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 41_500, plateRead: "BK 9101 AA", requestId: "scenario-a-0001" });
    expect(pending.statusCode).toBe(202);
    const exception = pending.json().exception;
    expect(exception.type).toBe("GROSS_IN");

    // the program sends the weight every two seconds while the supervisor looks
    clock.advance(2_000);
    expect((await station(wbIn.key, "POST", `/api/weighbridge/exceptions/${exception.id}/heartbeat`, { weightKg: 41_480 })).json().status).toBe("PENDING");
    const inbox = (await call("GET", "/api/exceptions?status=PENDING", "atasan")).json().items;
    expect(inbox).toEqual([expect.objectContaining({ id: exception.id, expectedValue: 41_000, liveWeightKg: 41_480, diffValue: 480, tolerancePct: 0.2 })]);
    const decided = await call("POST", `/api/exceptions/${exception.id}/decide`, "atasan", { decision: "APPROVE", reason: "Surat PKS salah tulis bruto" });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().exception).toMatchObject({ status: "APPROVED", reportNo: "0001/BA-SELISIH-BRUTO/SMK/XI/2026" });
    clock.advance(2_000);
    const answer = (await station(wbIn.key, "POST", `/api/weighbridge/exceptions/${exception.id}/heartbeat`, { weightKg: 41_480 })).json();
    expect(answer).toMatchObject({ status: "APPROVED", decision: "APPROVE", result: "SAVED", weighing: { stage: 1, weightKg: 41_480, mode: "EXCEPTION" }, trip: { status: "IN_PROCESS", currentStep: "QC" } });

    // the steps in between
    await complete(ctx, truck.tripId, "QC");
    await complete(ctx, truck.tripId, "UNLOADING");
    const tank = await complete(ctx, truck.tripId, "TANK_CHECK");
    expect(tank.trip.currentStep).toBe("WEIGH_2");

    // second weighing: net 31 020 against 31 000 is within 0.1 %
    const second = await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 10_460, plateRead: "BK9101AA" });
    expect(second.statusCode).toBe(200);
    expect(second.json().trip).toMatchObject({ grossKg: 41_480, tareKg: 10_460, netKg: 31_020, currentStep: "CHECK_OUT" });
    // 31 020 x 20 000 / 31 000 = 20 012.9 rounds to 20 013; the last contract takes 11 007
    expect(second.json().trip.allocations.map((line: { netKg: number; splitMethod: string }) => [line.netKg, line.splitMethod])).toEqual([[20_013, "PROPORTIONAL"], [11_007, "PROPORTIONAL"]]);

    const back = await call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid });
    expect(back.json().trip).toMatchObject({ status: "COMPLETED", card: null });

    const firstContract = second.json().trip.allocations[0].contractNo;
    const report = (await call("GET", `/api/reports/contracts?direction=IN&q=${encodeURIComponent(firstContract)}`, "admin4")).json().items;
    expect(report).toEqual([expect.objectContaining({ contractNo: firstContract, realised: 20_013, inProgress: 0, remaining: 479_987, tripCount: 1 })]);
    const ba = (await call("GET", `/api/exceptions/${exception.id}/report`, "atasan")).json().report;
    expect(ba).toMatchObject({ title: "Berita Acara Selisih Bruto", expectedKg: 41_000, weighedKg: 41_480, reason: "Surat PKS salah tulis bruto", lines: [{ seq: 1 }, { seq: 2 }] });
  });

  it("(b) an outgoing flexi-bag truck: tare difference made the master tare, 'add load' repeats loading, sealing and the second weighing", async () => {
    const ctx = await weighingApp();
    const { station, weigh, wbOut, call, database } = ctx;
    const truck = await ctx.outgoing({ plate: "BK 9202 BB", flexiBag: true, tareKg: 15_000, dos: [30_000] });

    const first = await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 15_200, plateRead: "BK9202BB" });
    expect(first.statusCode).toBe(202);
    const tare = first.json().exception;
    expect(tare.type).toBe("TARE_OUT");
    await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${tare.id}/heartbeat`, { weightKg: 15_200 });
    const approved = (await call("POST", `/api/exceptions/${tare.id}/decide`, "atasan", { decision: "APPROVE", reason: "Truk baru ganti tangki", updateMasterTare: true })).json();
    expect(approved.exception.reportNo).toBe("0001/BA-SELISIH-TARRA/SMK/XI/2026");
    expect(await database.query("select tare_kg from vehicles where id = $1", [truck.vehicleId])).toEqual([{ tare_kg: 15_200 }]);
    expect(await database.query("select count(*)::int as n from vehicle_tare_history where vehicle_id = $1 and source = 'WEIGHING'", [truck.vehicleId])).toEqual([{ n: 1 }]);
    expect((await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${tare.id}/heartbeat`, { weightKg: 15_200 })).json()).toMatchObject({ result: "SAVED", trip: { tareKg: 15_200 } });

    await complete(ctx, truck.tripId, "CLEANLINESS");
    await complete(ctx, truck.tripId, "QC_LOADING");
    await complete(ctx, truck.tripId, "LOADING");
    await complete(ctx, truck.tripId, "SEALING");

    // a flexi-bag truck always goes to the supervisor at the second weighing
    const light = await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 44_000, plateRead: "BK9202BB" });
    expect(light.statusCode).toBe(202);
    const firstNet = light.json().exception;
    expect(firstNet.type).toBe("NET_OUT");
    await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${firstNet.id}/heartbeat`, { weightKg: 44_000 });
    expect((await call("POST", `/api/exceptions/${firstNet.id}/decide`, "atasan", { decision: "ADD_LOAD" })).json().exception.status).toBe("RETRY");
    const retry = (await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${firstNet.id}/heartbeat`, { weightKg: 44_000 })).json();
    expect(retry).toMatchObject({ status: "RETRY", decision: "ADD_LOAD", result: "NOT_SAVED", speech: ["Muatan perlu ditambah.", "Timbang tidak disimpan.", "Kembali ke tempat muat."] });
    // the card is refused at the scale until loading and sealing are done again
    expect((await station(wbOut.key, "GET", `/api/weighbridge/card/${truck.cardUid}`)).json().error).toMatchObject({ code: "NOT_READY", waitingStep: "LOADING" });

    await complete(ctx, truck.tripId, "LOADING", { result: "PASS", note: "Tambah muatan" });
    await complete(ctx, truck.tripId, "SEALING");
    expect((await station(wbOut.key, "GET", `/api/weighbridge/card/${truck.cardUid}`)).json()).toMatchObject({ stage: 2, kind: "GROSS" });
    const full = await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 45_200, plateRead: "BK9202BB" });
    const secondNet = full.json().exception;
    expect(secondNet.type).toBe("NET_OUT");
    expect(secondNet.id).not.toBe(firstNet.id);
    await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${secondNet.id}/heartbeat`, { weightKg: 45_200 });
    expect((await call("POST", `/api/exceptions/${secondNet.id}/decide`, "atasan", { decision: "OK" })).json().exception).toMatchObject({ status: "APPROVED", decision: "OK", reportNo: null });
    const saved = (await station(wbOut.key, "POST", `/api/weighbridge/exceptions/${secondNet.id}/heartbeat`, { weightKg: 45_200 })).json();
    expect(saved).toMatchObject({ result: "SAVED", trip: { grossKg: 45_200, tareKg: 15_200, netKg: 30_000, currentStep: "CHECK_OUT" } });
    expect(saved.trip.allocations).toEqual([expect.objectContaining({ netKg: 30_000, splitMethod: "SINGLE" })]);

    const steps = await ctx.steps(truck.tripId);
    expect(steps.map((step) => `${step.step_code}#${step.attempt}:${step.status}`)).toEqual([
      "CHECK_IN#1:DONE", "WEIGH_1#1:DONE", "CLEANLINESS#1:DONE", "QC_LOADING#1:DONE", "LOADING#1:DONE", "LOADING#2:DONE",
      "SEALING#1:DONE", "SEALING#2:DONE", "WEIGH_2#1:FAILED", "WEIGH_2#2:DONE", "CHECK_OUT#1:READY",
    ]);
    const back = await call("POST", "/api/gate/check-out", "pos", { cardUid: truck.cardUid });
    expect(back.json().trip).toMatchObject({ status: "COMPLETED" });
    expect(await ctx.tripRow(truck.tripId)).toMatchObject({ status: "COMPLETED", outcome: "OK", net_kg: 30_000 });
  });

  it("refuses every weighbridge route without the station key", async () => {
    const { app } = await weighingApp();
    const routes: ["GET" | "POST", string][] = [
      ["GET", "/api/weighbridge/card/AA000001"],
      ["POST", "/api/weighbridge/weigh"],
      ["POST", "/api/weighbridge/exceptions/1/heartbeat"],
      ["POST", "/api/weighbridge/exceptions/1/cancel"],
      ["POST", "/api/weighbridge/manual-plate"],
      ["GET", "/api/weighbridge/speech?text=Halo"],
    ];
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error).toEqual({ code: "STATION_UNAUTHENTICATED", message: "Kunci stasiun tidak valid.", speech: ["Kunci stasiun tidak valid."] });
    }
  });
});
