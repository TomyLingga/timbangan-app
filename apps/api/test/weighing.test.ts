// The weighbridge program's routes when every check passes: card lookup, weigh with request id, steps,
// trip figures and the split of the net weight.
import { describe, expect, it } from "vitest";
import { setStationPin } from "../src/stations/pin.js";
import { weighingApp } from "./helpers/weighing.js";

describe("GET /api/weighbridge/card/:uid", () => {
  it("answers the trip, the stage and kind, what to expect and the camera, with message and speech", async () => {
    const { station, wbIn, incoming, forceReady } = await weighingApp();
    const truck = await incoming({ plate: "BK 8001 AA" });
    // an incoming CPO truck goes to the seal check first
    const early = await station(wbIn.key, "GET", `/api/weighbridge/card/${truck.cardUid}`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toEqual({
      code: "NOT_READY",
      message: "Truk belum siap ditimbang. Langkah sekarang: Cek segel.",
      speech: ["Truk belum siap ditimbang.", "Langkah sekarang: Cek segel."],
      waitingStep: "SEAL_CHECK",
    });

    await forceReady(truck.tripId, "WEIGH_1");
    const response = await station(wbIn.key, "GET", `/api/weighbridge/card/${truck.cardUid.toLowerCase()}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      stage: 1,
      kind: "GROSS",
      camera: 3,
      expected: { plateNo: "BK8001AA", plateDisplay: "BK 8001 AA", docGrossKg: 30_000, docNetKg: 20_000, vehicleTareKg: null },
      trip: { id: truck.tripId, direction: "IN", flowCode: "IN_CPO", status: "CHECKED_IN", currentStep: "WEIGH_1", plateNo: "BK8001AA", grossKg: null, tareKg: null, netKg: null },
      message: "Plat BK 8001 AA. Timbang pertama, bruto. Tunggu berat stabil.",
      speech: ["Plat B K delapan nol nol satu A A.", "Timbang pertama, bruto.", "Tunggu berat stabil."],
    });
    expect(body.trip.allocations).toEqual([expect.objectContaining({ seq: 1, contractNo: expect.any(String), netKg: null })]);
  });

  it("answers 404 CARD_UNKNOWN, 409 WRONG_STATION and 401 without a key", async () => {
    const { station, wbIn, wbOut, incoming, forceReady, app } = await weighingApp();
    const unknown = await station(wbIn.key, "GET", "/api/weighbridge/card/FFFF0000");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatchObject({ code: "CARD_UNKNOWN", message: "Kartu tidak dikenal.", speech: ["Kartu tidak dikenal."] });
    expect((await station(wbIn.key, "GET", "/api/weighbridge/card/not-hex")).json().error.code).toBe("CARD_UNKNOWN");

    const truck = await incoming();
    await forceReady(truck.tripId, "WEIGH_1");
    const wrong = await station(wbOut.key, "GET", `/api/weighbridge/card/${truck.cardUid}`);
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toMatchObject({ code: "WRONG_STATION", message: "Truk ini bukan untuk timbangan ini." });
    expect((await app.inject({ method: "GET", url: `/api/weighbridge/card/${truck.cardUid}` })).statusCode).toBe(401);
  });
});

describe("POST /api/weighbridge/weigh without exceptions", () => {
  it("saves the first weighing of an incoming truck, moves the steps on and is idempotent per request id", async () => {
    const { weigh, wbIn, incoming, forceReady, steps, tripRow, database } = await weighingApp();
    const truck = await incoming({ plate: "BK 8002 AA" });
    await forceReady(truck.tripId, "WEIGH_1");
    const body = { cardUid: truck.cardUid, weightKg: 30_010, plateRead: "bk 8002 aa", requestId: "wb-in-0001" };
    const first = await weigh(wbIn.key, body);
    expect(first.statusCode).toBe(200);
    const saved = first.json();
    expect(saved).toMatchObject({
      result: "SAVED",
      weighing: { stage: 1, kind: "GROSS", weightKg: 30_010, plateCheck: "MATCH", mode: "AUTO", weighedAt: "2026-11-20T03:00:00.000Z" },
      trip: { id: truck.tripId, status: "IN_PROCESS", grossKg: 30_010, tareKg: null, netKg: null, currentStep: "QC" },
      message: "Timbang pertama berhasil. Bruto 30.010 kg. Berikutnya: QC pass.",
      speech: ["Timbang pertama berhasil.", "Bruto 30.010 kilogram.", "Berikutnya: kiu si pass."],
    });
    expect(await tripRow(truck.tripId)).toMatchObject({ status: "IN_PROCESS", gross_kg: 30_010, current_step: "QC" });
    expect((await steps(truck.tripId)).map((step) => [step.step_code, step.status])).toEqual([
      ["CHECK_IN", "DONE"], ["SEAL_CHECK", "DONE"], ["WEIGH_1", "DONE"], ["QC", "READY"], ["UNLOADING", "PENDING"],
      ["TANK_CHECK", "PENDING"], ["RESEAL", "PENDING"], ["WEIGH_2", "PENDING"], ["CHECK_OUT", "PENDING"],
    ]);

    // the same request again: the same answer, still one weighing
    const again = await weigh(wbIn.key, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(saved);
    expect(await database.query("select count(*)::int as n from weighings")).toEqual([{ n: 1 }]);
    // a new request while no weighing step is ready
    const notReady = await weigh(wbIn.key, { ...body, requestId: "wb-in-0002" });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error).toMatchObject({ code: "NOT_READY", waitingStep: "QC" });
    expect((await weigh(wbIn.key, { ...body, requestId: "x" })).statusCode).toBe(400);
    expect((await weigh(wbIn.key, { ...body, weightKg: 0, requestId: "wb-in-0003" })).statusCode).toBe(400);
  });

  it("saves the second weighing, computes the net and splits it over two contracts by their origin nets", async () => {
    const { weigh, wbIn, incoming, forceReady, tripRow, allocations, steps } = await weighingApp();
    const truck = await incoming({ contracts: [{ originNetKg: 20_000 }, { originNetKg: 11_000 }] });
    await forceReady(truck.tripId, "WEIGH_1");
    expect((await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 41_001, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    await forceReady(truck.tripId, "WEIGH_2");
    const second = await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 10_000, plateRead: truck.plateNo });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      result: "SAVED",
      weighing: { stage: 2, kind: "TARE", weightKg: 10_000 },
      trip: { grossKg: 41_001, tareKg: 10_000, netKg: 31_001, currentStep: "CHECK_OUT" },
      message: "Timbang kedua berhasil. Tarra 10.000 kg. Netto 31.001 kg. Berikutnya: Kembalikan kartu.",
    });
    expect(await tripRow(truck.tripId)).toMatchObject({ gross_kg: 41_001, tare_kg: 10_000, net_kg: 31_001, status: "IN_PROCESS" });
    expect(await allocations(truck.tripId)).toEqual([
      { seq: 1, net_kg: 20_001, qty_actual: "20001.000", split_method: "PROPORTIONAL" },
      { seq: 2, net_kg: 11_000, qty_actual: "11000.000", split_method: "PROPORTIONAL" },
    ]);
    // the optional reseal was passed by
    expect((await steps(truck.tripId)).find((step) => step.step_code === "RESEAL")?.status).toBe("SKIPPED");
  });

  it("weighs an outgoing truck tare first, then gross, and gives a single DO the whole net", async () => {
    const { weigh, station, wbOut, outgoing, forceReady, allocations } = await weighingApp();
    const truck = await outgoing({ dos: [30_000] });
    // outgoing bulk: the first weighing follows check-in
    const card = (await station(wbOut.key, "GET", `/api/weighbridge/card/${truck.cardUid}`)).json();
    expect(card).toMatchObject({ stage: 1, kind: "TARE", camera: 1, expected: { vehicleTareKg: 15_000 } });
    expect(card.message).toBe(`Plat ${card.expected.plateDisplay}. Timbang pertama, tarra. Tunggu berat stabil.`);
    expect((await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 15_010, plateRead: truck.plateNo })).json().trip).toMatchObject({ tareKg: 15_010, currentStep: "CLEANLINESS" });
    await forceReady(truck.tripId, "WEIGH_2");
    expect((await station(wbOut.key, "GET", `/api/weighbridge/card/${truck.cardUid}`)).json()).toMatchObject({ stage: 2, kind: "GROSS", camera: 2 });
    const second = (await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 44_990, plateRead: truck.plateNo })).json();
    expect(second.trip).toMatchObject({ grossKg: 44_990, tareKg: 15_010, netKg: 29_980 });
    expect(await allocations(truck.tripId)).toEqual([{ seq: 1, net_kg: 29_980, qty_actual: "29980.000", split_method: "SINGLE" }]);
  });

  it("fills an outgoing truck's DOs from the smallest remainder", async () => {
    const { weigh, wbOut, outgoing, forceReady, allocations } = await weighingApp();
    const truck = await outgoing({ dos: [30_000, 8_000] });
    expect((await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 15_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    await forceReady(truck.tripId, "WEIGH_2");
    expect((await weigh(wbOut.key, { cardUid: truck.cardUid, weightKg: 40_000, plateRead: truck.plateNo })).json().result).toBe("SAVED");
    expect(await allocations(truck.tripId)).toEqual([
      { seq: 1, net_kg: 17_000, qty_actual: "17000.000", split_method: "SEQUENTIAL" },
      { seq: 2, net_kg: 8_000, qty_actual: "8000.000", split_method: "SEQUENTIAL" },
    ]);
  });
});

describe("POST /api/weighbridge/manual-plate", () => {
  it("opens manual plate entry with the station PIN and locks after five wrong attempts", async () => {
    const { station, wbIn, database, clock } = await weighingApp();
    const open = (pin: string) => station(wbIn.key, "POST", "/api/weighbridge/manual-plate", { pin });
    const notSet = await open("1234");
    expect(notSet.statusCode).toBe(409);
    expect(notSet.json().error).toMatchObject({ code: "PIN_NOT_SET", speech: ["pin stasiun belum diatur."] });
    await setStationPin(database.db, wbIn.id, "482915");
    expect((await open("482915")).json()).toEqual({ unlocked: true, message: "Mode ketik plat dibuka.", speech: ["Mode ketik plat dibuka."] });
    const wrong = await open("000000");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toEqual({ code: "PIN_WRONG", message: "PIN salah. Sisa 4 kali.", speech: ["pin salah.", "Sisa 4 kali."], attemptsLeft: 4 });
    for (let n = 0; n < 3; n++) await open("000000");
    const locked = await open("000000");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatchObject({ code: "PIN_LOCKED", lockedUntil: "2026-11-20T03:05:00.000Z" });
    expect((await open("482915")).statusCode).toBe(429);
    clock.advance(5 * 60_000 + 1);
    expect((await open("482915")).statusCode).toBe(200);
    expect((await station(wbIn.key, "POST", "/api/weighbridge/manual-plate", { pin: "12" })).statusCode).toBe(400);
  });
});

describe("PUT /api/trips/:id/split", () => {
  it("lets registrations EDIT replace the split by hand while the sum stays the truck's net", async () => {
    const { weigh, wbIn, incoming, forceReady, allocations, call, database } = await weighingApp();
    const truck = await incoming({ contracts: [{ originNetKg: 20_000 }, { originNetKg: 11_000 }] });
    const url = `/api/trips/${truck.tripId}/split`;
    // nothing to split before the second weighing
    expect((await call("PUT", url, "admin4", { allocations: [{ seq: 1, netKg: 1 }, { seq: 2, netKg: 1 }] })).json().error.code).toBe("INVALID_STATE");
    await forceReady(truck.tripId, "WEIGH_1");
    await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 41_000, plateRead: truck.plateNo });
    await forceReady(truck.tripId, "WEIGH_2");
    await weigh(wbIn.key, { cardUid: truck.cardUid, weightKg: 10_000, plateRead: truck.plateNo });

    const wrongSum = await call("PUT", url, "admin4", { allocations: [{ seq: 1, netKg: 20_000 }, { seq: 2, netKg: 10_000 }] });
    expect(wrongSum.statusCode).toBe(400);
    expect(wrongSum.json().error.fields).toEqual([{ field: "allocations", message: "Jumlah pembagian harus sama dengan netto truk (31.000 kg)." }]);
    expect((await call("PUT", url, "admin4", { allocations: [{ seq: 1, netKg: 31_000 }] })).statusCode).toBe(400);

    const manual = await call("PUT", url, "admin4", { allocations: [{ seq: 1, netKg: 25_000 }, { seq: 2, netKg: 6_000 }] });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().allocations).toEqual([
      expect.objectContaining({ seq: 1, netKg: 25_000, qtyActual: 25_000, splitMethod: "MANUAL" }),
      expect.objectContaining({ seq: 2, netKg: 6_000, qtyActual: 6_000, splitMethod: "MANUAL" }),
    ]);
    expect(await allocations(truck.tripId)).toEqual([
      { seq: 1, net_kg: 25_000, qty_actual: "25000.000", split_method: "MANUAL" },
      { seq: 2, net_kg: 6_000, qty_actual: "6000.000", split_method: "MANUAL" },
    ]);
    expect((await database.query<{ action: string }>("select action from audit_log where entity_type = 'trip' and action = 'NET_SPLIT_CHANGED'")).length).toBe(1);
  });
});
