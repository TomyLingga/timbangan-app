import { describe, expect, it } from "vitest";
import type { ApiFailure, HeartbeatAnswer } from "../src/shared/api-types";
import { type Effect, initialScreen, reduceScreen, SCREEN, type ScreenEvent, type ScreenState } from "../src/shared/screen";
import { cardAnswer, pendingAnswer, plateRetryAnswer, savedAnswer, stillPending, trip, weighing } from "./fixtures";

/** The reducer with a counter for request ids; keeps every effect. */
function machine(start = 0) {
  let ids = 0;
  const env = { newRequestId: () => `req-${String(++ids).padStart(4, "0")}` };
  let state: ScreenState = initialScreen(start);
  const effects: Effect[] = [];
  const send = (event: ScreenEvent) => {
    const step = reduceScreen(state, event, env);
    state = step.state;
    effects.push(...step.effects);
    return step.effects;
  };
  /** Ticks every 250 ms from `from` to `to` inclusive. */
  const ticks = (from: number, to: number) => {
    const out: Effect[] = [];
    for (let now = from; now <= to; now += 250) out.push(...send({ type: "tick", now }));
    return out;
  };
  return { send, ticks, effects, get state() { return state; } };
}

const of = <T extends Effect["type"]>(effects: Effect[], type: T) => effects.filter((effect): effect is Extract<Effect, { type: T }> => effect.type === type);
const network: ApiFailure = { kind: "network", message: "timeout" };
const apiError = (status: number, code: string, message: string, details: Record<string, unknown> = {}): ApiFailure => ({ kind: "api", status, code, message, speech: [message], details });

/** A truck shown after its card, with the weight on the scale. */
function truckOn(weightKg = 41_500) {
  const m = machine();
  m.send({ type: "card", uid: "04A1B2C3D4", now: 0 });
  m.send({ type: "cardAnswer", uid: "04A1B2C3D4", answer: cardAnswer(), now: 100 });
  m.send({ type: "plate", text: "XX 1234 AB" });
  m.send({ type: "weight", weightKg });
  return m;
}

/** A truck whose weight was stable and sent: the attempt is in flight. */
function sent(weightKg = 41_500) {
  const m = truckOn(weightKg);
  m.ticks(250, 4_250);
  expect(m.state.phase).toBe("sending");
  return m;
}

/** A truck waiting for a decision on request 5, from time 5 000. */
function waiting() {
  const m = sent();
  m.send({ type: "weighAnswer", requestId: "req-0001", answer: pendingAnswer(5), now: 5_000 });
  expect(m.state.phase).toBe("waiting");
  return m;
}

describe("card", () => {
  it("waits for a card, looks it up and shows the truck with its speech and camera", () => {
    const m = machine();
    expect(m.state.phase).toBe("idle");
    expect(m.send({ type: "card", uid: "04A1B2C3D4", now: 0 })).toEqual([{ type: "lookupCard", uid: "04A1B2C3D4" }]);
    expect(m.state.phase).toBe("lookup");
    const effects = m.send({ type: "cardAnswer", uid: "04A1B2C3D4", answer: cardAnswer(), now: 100 });
    expect(m.state.phase).toBe("truck");
    expect(m.state.card?.trip.tripNo).toBe("TRP-0007");
    expect(m.state.message).toBe("Plat XX 1234 AB. Timbang pertama, bruto. Tunggu berat stabil.");
    expect(effects).toEqual([
      { type: "watchPlate", camera: 3 },
      { type: "speak", segments: ["Plat X X satu dua tiga empat A B.", "Timbang pertama, bruto.", "Tunggu berat stabil."] },
    ]);
  });

  it.each([
    ["CARD_UNKNOWN", apiError(404, "CARD_UNKNOWN", "Kartu tidak dikenal.")],
    ["NOT_READY", apiError(409, "NOT_READY", "Truk belum siap ditimbang. Langkah sekarang: QC.", { waitingStep: "QC" })],
    ["WRONG_STATION", apiError(409, "WRONG_STATION", "Truk ini bukan untuk timbangan ini.")],
  ])("refuses %s with the API's own message, then goes back to waiting", (code, failure) => {
    const m = machine();
    m.send({ type: "card", uid: "04A1B2C3D4", now: 0 });
    const effects = m.send({ type: "cardFailed", uid: "04A1B2C3D4", failure, now: 200 });
    expect(m.state.phase).toBe("refused");
    expect(m.state.outcome).toEqual({ kind: "REFUSED", code });
    expect(m.state.message).toBe(failure.kind === "api" ? failure.message : "");
    expect(of(effects, "speak")).toEqual([{ type: "speak", segments: failure.kind === "api" ? failure.speech : [] }]);
    m.ticks(250, 200 + SCREEN.resultHoldMs - 250);
    expect(m.state.phase).toBe("refused");
    m.send({ type: "tick", now: 200 + SCREEN.resultHoldMs });
    expect(m.state.phase).toBe("idle");
    expect(m.state.card).toBeNull();
  });

  it("refuses with a plain message when the server does not answer", () => {
    const m = machine();
    m.send({ type: "card", uid: "04A1B2C3D4", now: 0 });
    m.send({ type: "cardFailed", uid: "04A1B2C3D4", failure: network, now: 200 });
    expect(m.state.outcome).toEqual({ kind: "REFUSED", code: "NETWORK" });
    expect(m.state.message).toBe("Server tidak menjawab. Tempel kartu lagi.");
  });

  it("ignores the answer for a card that is no longer the current one", () => {
    const m = machine();
    m.send({ type: "card", uid: "1111111111", now: 0 });
    m.send({ type: "card", uid: "2222222222", now: 50 });
    m.send({ type: "cardAnswer", uid: "1111111111", answer: cardAnswer(), now: 100 });
    expect(m.state.phase).toBe("lookup");
    expect(m.state.cardUid).toBe("2222222222");
  });

  it("ignores a card while a weight is being sent or a decision is awaited", () => {
    const busy = sent();
    expect(busy.send({ type: "card", uid: "2222222222", now: 4_300 })).toEqual([]);
    const wait = waiting();
    expect(wait.send({ type: "card", uid: "2222222222", now: 5_100 })).toEqual([]);
    expect(wait.state.phase).toBe("waiting");
  });

  it("goes back to waiting when no stable weight comes in time", () => {
    const m = truckOn(0);
    m.send({ type: "tick", now: SCREEN.truckTimeoutMs - 1 });
    expect(m.state.phase).toBe("truck");
    const effects = m.send({ type: "tick", now: SCREEN.truckTimeoutMs + 100 });
    expect(m.state.phase).toBe("idle");
    expect(effects).toContainEqual({ type: "watchPlate", camera: null });
  });
});

describe("weight", () => {
  it("shows settling, then the countdown, then sends the stable weight with the camera plate and a new request id", () => {
    const m = truckOn();
    m.send({ type: "tick", now: 250 });
    expect(m.state.phase).toBe("settling");
    m.ticks(500, 1_000);
    expect(m.state.phase).toBe("settling");
    m.send({ type: "tick", now: 1_250 });
    expect(m.state.phase).toBe("countdown");
    expect(m.state.countdownLeft).toBe(3);
    m.ticks(1_500, 2_750);
    expect(m.state.countdownLeft).toBe(2);
    m.ticks(3_000, 4_000);
    expect(m.state.countdownLeft).toBe(1);
    const effects = m.send({ type: "tick", now: 4_250 });
    expect(m.state.phase).toBe("sending");
    expect(of(effects, "weigh")).toEqual([{ type: "weigh", cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX 1234 AB", requestId: "req-0001" }]);
    expect(of(effects, "log")).toEqual([{ type: "log", event: "stable", data: { cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX 1234 AB" } }]);
  });

  it("restarts the countdown when the weight moves", () => {
    const m = truckOn();
    m.ticks(250, 1_500);
    expect(m.state.phase).toBe("countdown");
    m.send({ type: "weight", weightKg: 41_540 });
    m.send({ type: "tick", now: 1_750 });
    expect(m.state.phase).toBe("settling");
  });

  it("is back at the truck view when the scale is empty", () => {
    const m = truckOn();
    m.ticks(250, 1_000);
    m.send({ type: "weight", weightKg: 0 });
    m.send({ type: "tick", now: 1_250 });
    expect(m.state.phase).toBe("truck");
  });

  it("shows and speaks an unstable notice after ten changes, and keeps the truck", () => {
    const m = truckOn(40_000);
    const effects: unknown[] = [];
    for (let i = 0; i <= 10; i++) {
      m.send({ type: "weight", weightKg: 40_000 + i * 20 });
      effects.push(...m.send({ type: "tick", now: 250 + i * 500 }));
    }
    expect(m.state.notice).toBe("Berat belum stabil. Truk diam di tengah timbangan.");
    expect(effects).toContainEqual({ type: "speak", segments: ["Berat belum stabil.", "Truk diam di tengah timbangan."] });
    expect(m.state.card).not.toBeNull();
  });

  it("sends the plate typed in manual mode instead of the camera's", () => {
    const m = truckOn();
    m.send({ type: "manualPlate", text: "XX 1234 AB" });
    m.send({ type: "plate", text: "XX 1Z34 AB" });
    const effects = m.ticks(250, 4_250);
    expect(of(effects, "weigh")[0]?.plateRead).toBe("XX 1234 AB");
  });
});

describe("answers to a weighing", () => {
  it("shows a saved weighing, speaks it, stops the plate reader, and goes back to waiting after the hold", () => {
    const m = sent();
    const effects = m.send({ type: "weighAnswer", requestId: "req-0001", answer: savedAnswer(41_500), now: 5_000 });
    expect(m.state.phase).toBe("saved");
    expect(m.state.outcome).toMatchObject({ kind: "SAVED", afterDecision: false, weighing: { weightKg: 41_500 } });
    expect(effects).toEqual([
      { type: "watchPlate", camera: null },
      { type: "speak", segments: ["Timbang pertama berhasil.", "Bruto 41500 kilogram."] },
    ]);
    m.send({ type: "tick", now: 5_000 + SCREEN.resultHoldMs });
    expect(m.state.phase).toBe("idle");
    expect(m.state.message).toBe("Tempel kartu.");
  });

  it("keeps the camera plate on screen with the result, and clears it for the next truck", () => {
    const m = sent();
    m.send({ type: "weighAnswer", requestId: "req-0001", answer: savedAnswer(41_500), now: 5_000 });
    expect(m.state.cameraPlate).toBe("XX 1234 AB");
    m.send({ type: "tick", now: 5_000 + SCREEN.resultHoldMs });
    expect(m.state.cameraPlate).toBeNull();
  });

  it("ignores an answer to an earlier attempt", () => {
    const m = sent();
    m.send({ type: "weighAnswer", requestId: "req-9999", answer: savedAnswer(41_500), now: 5_000 });
    expect(m.state.phase).toBe("sending");
  });

  it("on a plate retry shows the attempts left, settles again and sends a new attempt with a new request id and the newest plate", () => {
    const m = sent();
    m.send({ type: "weighAnswer", requestId: "req-0001", answer: plateRetryAnswer(2), now: 5_000 });
    expect(m.state.phase).toBe("plateRetry");
    expect(m.state.plateAttemptsLeft).toBe(2);
    m.send({ type: "plate", text: "XX 1234 AC" });
    m.ticks(5_250, 5_000 + SCREEN.plateRetryPauseMs - 250);
    expect(m.state.phase).toBe("plateRetry");
    const effects = m.ticks(5_000 + SCREEN.plateRetryPauseMs, 5_000 + SCREEN.plateRetryPauseMs + 4_500);
    expect(of(effects, "weigh")).toEqual([{ type: "weigh", cardUid: "04A1B2C3D4", weightKg: 41_500, plateRead: "XX 1234 AC", requestId: "req-0002" }]);
  });

  it("re-sends the same attempt with the same request id when the server does not answer, then gives up", () => {
    const m = sent();
    m.send({ type: "weighFailed", requestId: "req-0001", failure: network, now: 5_000 });
    expect(m.state.phase).toBe("sending");
    const resent: Effect[] = [];
    let now = 5_000;
    for (let i = 0; i < SCREEN.sendRetries; i++) {
      now += SCREEN.sendRetryMs;
      resent.push(...m.send({ type: "tick", now }));
      m.send({ type: "weighFailed", requestId: "req-0001", failure: network, now });
    }
    expect(of(resent, "weigh").map((effect) => effect.requestId)).toEqual(Array(SCREEN.sendRetries).fill("req-0001"));
    expect(m.state.phase).toBe("refused");
    expect(m.state.outcome).toEqual({ kind: "REFUSED", code: "NETWORK" });
  });

  it("refuses with the API's message when the API turns the weighing down", () => {
    const m = sent();
    m.send({ type: "weighFailed", requestId: "req-0001", failure: apiError(409, "NOT_READY", "Truk belum siap ditimbang."), now: 5_000 });
    expect(m.state.phase).toBe("refused");
    expect(m.state.outcome).toEqual({ kind: "REFUSED", code: "NOT_READY" });
    expect(m.state.message).toBe("Truk belum siap ditimbang.");
  });
});

describe("reset", () => {
  it("drops a truck on screen and goes back to waiting for a card, stopping the plate reader", () => {
    const m = truckOn();
    const effects = m.send({ type: "reset", now: 500 });
    expect(m.state.phase).toBe("idle");
    expect(m.state.card).toBeNull();
    expect(effects).toEqual([{ type: "log", event: "reset", data: { phase: "truck", cardUid: "04A1B2C3D4" } }, { type: "watchPlate", camera: null }]);
  });

  it("cancels a waiting request by the operator before going back to waiting", () => {
    const m = waiting();
    const effects = m.send({ type: "reset", now: 6_000 });
    expect(m.state.phase).toBe("idle");
    expect(effects).toContainEqual({ type: "cancel", exceptionId: 5, reason: "OPERATOR" });
    // the late answer of the cancel changes nothing
    m.send({ type: "cancelAnswer", exceptionId: 5, answer: { status: "CANCELLED", message: "Permintaan dibatalkan.", speech: [] }, now: 6_100 });
    expect(m.state.phase).toBe("idle");
  });

  it("ignores the answer of a weighing that was on its way", () => {
    const m = sent();
    m.send({ type: "reset", now: 4_300 });
    m.send({ type: "weighAnswer", requestId: "req-0001", answer: savedAnswer(41_500), now: 4_400 });
    expect(m.state.phase).toBe("idle");
  });
});

describe("plate attempts", () => {
  it("counts each attempt sent for the card, and starts again for the next card", () => {
    const m = sent();
    expect(m.state.plateTry).toBe(1);
    m.send({ type: "weighAnswer", requestId: "req-0001", answer: plateRetryAnswer(2), now: 5_000 });
    m.ticks(5_000 + SCREEN.plateRetryPauseMs, 5_000 + SCREEN.plateRetryPauseMs + 4_500);
    expect(m.state.plateTry).toBe(2);
    m.send({ type: "weighAnswer", requestId: "req-0002", answer: savedAnswer(41_500), now: 19_000 });
    m.send({ type: "card", uid: "1111111111", now: 20_000 });
    expect(m.state.plateTry).toBe(0);
  });
});

describe("waiting for a decision", () => {
  it("speaks why, then sends the current weight every 2 seconds, one call at a time", () => {
    const m = sent();
    const entered = m.send({ type: "weighAnswer", requestId: "req-0001", answer: pendingAnswer(5), now: 5_000 });
    expect(m.state.exception).toEqual({ id: 5, type: "GROSS_IN" });
    expect(of(entered, "speak")).toHaveLength(1);
    m.send({ type: "weight", weightKg: 41_480 });
    expect(m.send({ type: "tick", now: 6_000 })).toEqual([]);
    expect(m.send({ type: "tick", now: 7_000 })).toEqual([{ type: "heartbeat", exceptionId: 5, weightKg: 41_480 }]);
    // the previous call has not come back: no second call
    expect(m.send({ type: "tick", now: 9_000 })).toEqual([]);
    m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: stillPending, now: 9_100 });
    expect(m.send({ type: "tick", now: 9_250 })).toEqual([{ type: "heartbeat", exceptionId: 5, weightKg: 41_480 }]);
    expect(m.state.phase).toBe("waiting");
  });

  it("does not repeat the waiting sentence on every heartbeat", () => {
    const m = waiting();
    m.send({ type: "tick", now: 7_000 });
    expect(m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: stillPending, now: 7_100 })).toEqual([]);
  });

  it("keeps waiting when a heartbeat gets no answer", () => {
    const m = waiting();
    m.send({ type: "tick", now: 7_000 });
    m.send({ type: "heartbeatFailed", exceptionId: 5, failure: network, now: 7_500 });
    expect(m.state.phase).toBe("waiting");
    expect(m.send({ type: "tick", now: 9_000 })).toEqual([{ type: "heartbeat", exceptionId: 5, weightKg: 41_500 }]);
  });

  it("shows the weighing saved after approval", () => {
    const m = waiting();
    m.send({ type: "tick", now: 7_000 });
    const approved: HeartbeatAnswer = { status: "APPROVED", decision: "APPROVE", result: "SAVED", weighing: weighing(41_480, { mode: "EXCEPTION" }), trip: trip({ status: "IN_PROCESS", grossKg: 41_480 }), message: "Permintaan disetujui. Timbang pertama berhasil.", speech: ["Permintaan disetujui.", "Timbang pertama berhasil."] };
    const effects = m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: approved, now: 7_100 });
    expect(m.state.phase).toBe("decided");
    expect(m.state.outcome).toMatchObject({ kind: "SAVED", afterDecision: true, weighing: { weightKg: 41_480 } });
    expect(effects).toContainEqual({ type: "speak", segments: ["Permintaan disetujui.", "Timbang pertama berhasil."] });
  });

  it.each([
    ["REJECTED", "REJECT", "REJECTED"],
    ["RETRY", "ADD_LOAD", "ADD_LOAD"],
    ["RETRY", "REDUCE_LOAD", "REDUCE_LOAD"],
    ["CANCELLED", undefined, "CANCELLED"],
  ] as const)("shows status %s decision %s as not saved: %s", (status, decision, reason) => {
    const m = waiting();
    m.send({ type: "tick", now: 7_000 });
    m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: { status, ...(decision ? { decision } : {}), result: "NOT_SAVED", message: "Tidak disimpan.", speech: ["Tidak disimpan."] }, now: 7_100 });
    expect(m.state.phase).toBe("decided");
    expect(m.state.outcome).toEqual({ kind: "NOT_SAVED", reason });
  });

  it("follows the next request when an approved plate leads to another check", () => {
    const m = waiting();
    m.send({ type: "tick", now: 7_000 });
    const next: HeartbeatAnswer = { status: "APPROVED", decision: "APPROVE", result: "PENDING", exception: { id: 6, type: "GROSS_IN" }, message: "Permintaan disetujui. Selisih bruto.", speech: ["Permintaan disetujui.", "Selisih bruto."] };
    const effects = m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: next, now: 7_100 });
    expect(m.state.phase).toBe("waiting");
    expect(m.state.exception).toEqual({ id: 6, type: "GROSS_IN" });
    expect(of(effects, "speak")).toHaveLength(1);
    expect(m.send({ type: "tick", now: 9_100 })).toEqual([{ type: "heartbeat", exceptionId: 6, weightKg: 41_500 }]);
  });

  it("cancels when the truck stays below 1000 kg for 5 seconds, sends no more heartbeats, and shows the cancel", () => {
    const m = waiting();
    m.send({ type: "weight", weightKg: 300 });
    const before = m.ticks(5_250, 10_000);
    expect(of(before, "cancel")).toEqual([]);
    expect(m.state.truckLeftSecondsLeft).toBe(1);
    const effects = m.send({ type: "tick", now: 10_250 });
    expect(of(effects, "cancel")).toEqual([{ type: "cancel", exceptionId: 5, reason: "TRUCK_LEFT" }]);
    expect(of(m.ticks(10_500, 14_000), "heartbeat")).toEqual([]);
    m.send({ type: "cancelAnswer", exceptionId: 5, answer: { status: "CANCELLED", message: "Permintaan dibatalkan. Truk belum menimbang.", speech: ["Permintaan dibatalkan.", "Truk belum menimbang."] }, now: 14_100 });
    expect(m.state.phase).toBe("decided");
    expect(m.state.outcome).toEqual({ kind: "NOT_SAVED", reason: "TRUCK_LEFT" });
    expect(m.state.message).toBe("Permintaan dibatalkan. Truk belum menimbang.");
  });

  it("asks for the decision when the cancel finds the request already decided", () => {
    const m = waiting();
    m.send({ type: "weight", weightKg: 300 });
    m.ticks(5_250, 10_250);
    const effects = m.send({ type: "cancelFailed", exceptionId: 5, failure: apiError(409, "ALREADY_DECIDED", "Permintaan ini sudah diputuskan."), now: 10_300 });
    expect(effects).toEqual([{ type: "heartbeat", exceptionId: 5, weightKg: 300 }]);
    m.send({ type: "heartbeatAnswer", exceptionId: 5, answer: { status: "REJECTED", decision: "REJECT", result: "NOT_SAVED", message: "Permintaan ditolak.", speech: ["Permintaan ditolak."] }, now: 10_400 });
    expect(m.state.outcome).toEqual({ kind: "NOT_SAVED", reason: "REJECTED" });
  });

  it("shows the truck as gone when the cancel gets no answer (the API expires the request on its own)", () => {
    const m = waiting();
    m.send({ type: "weight", weightKg: 300 });
    m.ticks(5_250, 10_250);
    m.send({ type: "cancelFailed", exceptionId: 5, failure: network, now: 10_300 });
    expect(m.state.outcome).toEqual({ kind: "NOT_SAVED", reason: "TRUCK_LEFT" });
    expect(m.state.message).toBe("Truk turun dari timbangan. Permintaan dibatalkan.");
  });
});
