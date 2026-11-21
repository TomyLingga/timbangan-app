// The screen of the weighbridge as a pure state machine. Events come in (a card, a scale reading, a camera plate,
// a timer tick with the time, the answer of an API call); the reducer returns the next state and the effects to
// run (API calls, speech, plate polling, log lines). Time only comes in through events, so tests need no clock.
import type { ApiFailure, CancelAnswer, CardAnswer, ExceptionType, HeartbeatAnswer, TripView, WeighAnswer, WeighingView } from "./api-types";
import { initialStability, sampleStability, type StabilityState } from "./stability";
import { initialTruckLeft, type TruckLeftState, watchTruckLeft } from "./truck-left";

export const SCREEN = {
  /** Weight sent while a decision is awaited (the API cancels after 10 s without one). */
  heartbeatMs: 2_000,
  /** How long a result stays on screen before the program waits for the next card. */
  resultHoldMs: 10_000,
  /** Pause after "plate not read right" before the weight is settled and sent again. */
  plateRetryPauseMs: 2_000,
  /** Re-sends of the same attempt (same request id) when the server did not answer. */
  sendRetryMs: 3_000,
  sendRetries: 3,
  /** A card read but no stable weight for this long: back to waiting. */
  truckTimeoutMs: 180_000,
} as const;

export type PhaseName = "idle" | "lookup" | "truck" | "settling" | "countdown" | "sending" | "saved" | "plateRetry" | "waiting" | "decided" | "refused";

export type NotSavedReason = "REJECTED" | "ADD_LOAD" | "REDUCE_LOAD" | "CANCELLED" | "TRUCK_LEFT" | "OTHER";

export type Outcome =
  | { kind: "SAVED"; weighing: WeighingView; trip: TripView | null; afterDecision: boolean }
  | { kind: "NOT_SAVED"; reason: NotSavedReason }
  | { kind: "REFUSED"; code: string };

/** One weighing attempt: one request id, re-sent unchanged when the server did not answer. */
export interface Attempt {
  requestId: string;
  weightKg: number;
  plateRead: string | null;
  sends: number;
  retryAt: number | null;
}

export interface ScreenState {
  phase: PhaseName;
  phaseSince: number;
  cardUid: string | null;
  card: CardAnswer | null;
  cardShownAt: number | null;
  /** The latest scale reading; null when the scale gives none. */
  weightKg: number | null;
  cameraPlate: string | null;
  /** A plate typed in manual mode; sent instead of the camera's. */
  manualPlate: string | null;
  stability: StabilityState;
  countdownLeft: number | null;
  attempt: Attempt | null;
  plateAttemptsLeft: number | null;
  plateRetryUntil: number | null;
  exception: { id: number; type: ExceptionType } | null;
  heartbeat: { nextAt: number; inFlight: boolean } | null;
  cancelling: boolean;
  truckLeft: TruckLeftState;
  truckLeftSecondsLeft: number | null;
  outcome: Outcome | null;
  /** The text on screen: the API's `message`, or a local one. */
  message: string;
  notice: string | null;
  holdUntil: number | null;
}

export type ScreenEvent =
  | { type: "card"; uid: string; now: number }
  | { type: "cardAnswer"; uid: string; answer: CardAnswer; now: number }
  | { type: "cardFailed"; uid: string; failure: ApiFailure; now: number }
  | { type: "weight"; weightKg: number | null }
  | { type: "plate"; text: string | null }
  | { type: "manualPlate"; text: string | null }
  | { type: "tick"; now: number }
  | { type: "weighAnswer"; requestId: string; answer: WeighAnswer; now: number }
  | { type: "weighFailed"; requestId: string; failure: ApiFailure; now: number }
  | { type: "heartbeatAnswer"; exceptionId: number; answer: HeartbeatAnswer; now: number }
  | { type: "heartbeatFailed"; exceptionId: number; failure: ApiFailure; now: number }
  | { type: "cancelAnswer"; exceptionId: number; answer: CancelAnswer; now: number }
  | { type: "cancelFailed"; exceptionId: number; failure: ApiFailure; now: number };

export type Effect =
  | { type: "lookupCard"; uid: string }
  | { type: "weigh"; cardUid: string; weightKg: number; plateRead: string | null; requestId: string }
  | { type: "heartbeat"; exceptionId: number; weightKg: number }
  | { type: "cancel"; exceptionId: number; reason: "TRUCK_LEFT" }
  | { type: "speak"; segments: string[] }
  | { type: "watchPlate"; camera: number | null }
  | { type: "log"; event: string; data: Record<string, unknown> };

export interface ScreenEnv {
  newRequestId(): string;
}

/** Local texts: the ones the API cannot give because it was not reached or not asked. */
export const TEXT = {
  idle: "Tempel kartu.",
  lookup: "Membaca kartu...",
  sending: "Mengirim berat...",
  unstable: { message: "Berat belum stabil. Truk diam di tengah timbangan.", speech: ["Berat belum stabil.", "Truk diam di tengah timbangan."] },
  noServer: { message: "Server tidak menjawab. Tempel kartu lagi.", speech: ["Server tidak menjawab.", "Tempel kartu lagi."] },
  timeout: { message: "Waktu habis. Tempel kartu lagi.", speech: ["Waktu habis.", "Tempel kartu lagi."] },
  truckLeft: { message: "Truk turun dari timbangan. Permintaan dibatalkan.", speech: ["Truk turun dari timbangan.", "Permintaan dibatalkan."] },
} as const;

type Step = { state: ScreenState; effects: Effect[] };

export function initialScreen(now: number): ScreenState {
  return {
    phase: "idle",
    phaseSince: now,
    cardUid: null,
    card: null,
    cardShownAt: null,
    weightKg: null,
    cameraPlate: null,
    manualPlate: null,
    stability: initialStability(),
    countdownLeft: null,
    attempt: null,
    plateAttemptsLeft: null,
    plateRetryUntil: null,
    exception: null,
    heartbeat: null,
    cancelling: false,
    truckLeft: initialTruckLeft(),
    truckLeftSecondsLeft: null,
    outcome: null,
    message: TEXT.idle,
    notice: null,
    holdUntil: null,
  };
}

const speak = (segments: readonly string[]): Effect[] => (segments.length ? [{ type: "speak", segments: [...segments] }] : []);
const enter = (state: ScreenState, phase: PhaseName, now: number, patch: Partial<ScreenState> = {}): ScreenState => ({ ...state, phase, phaseSince: now, ...patch });

/** Back to waiting for a card; the scale reading stays, the camera plate of the last truck goes. */
const toIdle = (state: ScreenState, now: number): ScreenState => ({ ...initialScreen(now), weightKg: state.weightKg });

/** A result on screen for a while: saved, decided or refused. The plate reader stops. */
function finish(state: ScreenState, phase: "saved" | "decided" | "refused", outcome: Outcome, message: string, speech: readonly string[], now: number): Step {
  const next = enter(state, phase, now, {
    outcome,
    message,
    notice: null,
    holdUntil: now + SCREEN.resultHoldMs,
    attempt: null,
    heartbeat: null,
    cancelling: false,
    countdownLeft: null,
    truckLeftSecondsLeft: null,
  });
  return { state: next, effects: [{ type: "watchPlate", camera: null }, ...speak(speech)] };
}

function refuse(state: ScreenState, failure: ApiFailure, now: number): Step {
  if (failure.kind === "network") return finish(state, "refused", { kind: "REFUSED", code: "NETWORK" }, TEXT.noServer.message, TEXT.noServer.speech, now);
  return finish(state, "refused", { kind: "REFUSED", code: failure.code }, failure.message, failure.speech, now);
}

/** Can a new card start over now? Not while a weight is on its way or a decision is awaited. */
const takesCard = (phase: PhaseName) => phase !== "sending" && phase !== "waiting";

function onCard(state: ScreenState, uid: string, now: number): Step {
  if (!takesCard(state.phase)) return { state, effects: [] };
  const next = enter(toIdle(state, now), "lookup", now, { cardUid: uid, message: TEXT.lookup });
  return { state: next, effects: [{ type: "lookupCard", uid }] };
}

function onCardAnswer(state: ScreenState, uid: string, answer: CardAnswer, now: number): Step {
  if (state.phase !== "lookup" || state.cardUid !== uid) return { state, effects: [] };
  const next = enter(state, "truck", now, { card: answer, cardShownAt: now, message: answer.message, stability: initialStability() });
  return { state: next, effects: [{ type: "watchPlate", camera: answer.camera }, ...speak(answer.speech)] };
}

/** Starts sending a stable weight as a new attempt. */
function startAttempt(state: ScreenState, weightKg: number, now: number, env: ScreenEnv): Step {
  const cardUid = state.cardUid ?? "";
  const plateRead = state.manualPlate ?? state.cameraPlate;
  const attempt: Attempt = { requestId: env.newRequestId(), weightKg, plateRead, sends: 1, retryAt: null };
  const next = enter(state, "sending", now, { attempt, countdownLeft: null, message: TEXT.sending, notice: null });
  return {
    state: next,
    effects: [
      { type: "log", event: "stable", data: { cardUid, weightKg, plateRead } },
      { type: "weigh", cardUid, weightKg, plateRead, requestId: attempt.requestId },
    ],
  };
}

/** The scale while a truck is shown: settling, countdown, and the stable weight. */
function tickWeighing(state: ScreenState, now: number, env: ScreenEnv): Step {
  if (state.cardShownAt !== null && now - state.cardShownAt >= SCREEN.truckTimeoutMs) {
    return { state: { ...toIdle(state, now), message: TEXT.timeout.message }, effects: [{ type: "watchPlate", camera: null }, ...speak(TEXT.timeout.speech)] };
  }
  const step = sampleStability(state.stability, state.weightKg, now);
  const effects: Effect[] = [];
  let next: ScreenState = { ...state, stability: step.state };
  if (step.unstable) {
    next = { ...next, notice: TEXT.unstable.message };
    effects.push({ type: "log", event: "unstable", data: { cardUid: state.cardUid } }, ...speak(TEXT.unstable.speech));
  }
  const status = step.status;
  switch (status.kind) {
    case "empty":
      next = next.phase === "truck" ? next : enter(next, "truck", now, { countdownLeft: null });
      break;
    case "settling":
      next = next.phase === "settling" ? next : enter(next, "settling", now, { countdownLeft: null });
      break;
    case "countdown":
      next = next.phase === "countdown" ? { ...next, countdownLeft: status.secondsLeft } : enter(next, "countdown", now, { countdownLeft: status.secondsLeft });
      break;
    case "stable": {
      const sent = startAttempt(next, status.weightKg, now, env);
      return { state: sent.state, effects: [...effects, ...sent.effects] };
    }
  }
  return { state: next, effects };
}

function onWeighAnswer(state: ScreenState, requestId: string, answer: WeighAnswer, now: number): Step {
  if (state.phase !== "sending" || state.attempt?.requestId !== requestId) return { state, effects: [] };
  switch (answer.result) {
    case "SAVED":
      return finish(state, "saved", { kind: "SAVED", weighing: answer.weighing, trip: answer.trip, afterDecision: false }, answer.message, answer.speech, now);
    case "PLATE_RETRY": {
      const next = enter(state, "plateRetry", now, { attempt: null, plateAttemptsLeft: answer.attemptsLeft, plateRetryUntil: now + SCREEN.plateRetryPauseMs, message: answer.message });
      return { state: next, effects: speak(answer.speech) };
    }
    case "PENDING": {
      const next = enter(state, "waiting", now, {
        attempt: null,
        exception: answer.exception,
        heartbeat: { nextAt: now + SCREEN.heartbeatMs, inFlight: false },
        cancelling: false,
        truckLeft: initialTruckLeft(),
        truckLeftSecondsLeft: null,
        message: answer.message,
      });
      return { state: next, effects: speak(answer.speech) };
    }
  }
}

function onWeighFailed(state: ScreenState, requestId: string, failure: ApiFailure, now: number): Step {
  const attempt = state.attempt;
  if (state.phase !== "sending" || attempt?.requestId !== requestId) return { state, effects: [] };
  if (failure.kind === "network" && attempt.sends <= SCREEN.sendRetries) {
    return { state: { ...state, attempt: { ...attempt, retryAt: now + SCREEN.sendRetryMs } }, effects: [] };
  }
  return refuse(state, failure, now);
}

function tickSending(state: ScreenState, now: number): Step {
  const attempt = state.attempt;
  if (!attempt || attempt.retryAt === null || now < attempt.retryAt) return { state, effects: [] };
  const again: Attempt = { ...attempt, sends: attempt.sends + 1, retryAt: null };
  return {
    state: { ...state, attempt: again },
    effects: [{ type: "weigh", cardUid: state.cardUid ?? "", weightKg: again.weightKg, plateRead: again.plateRead, requestId: again.requestId }],
  };
}

function tickWaiting(state: ScreenState, now: number): Step {
  const exception = state.exception;
  const heartbeat = state.heartbeat;
  if (!exception || !heartbeat || state.cancelling) return { state, effects: [] };
  const watch = watchTruckLeft(state.truckLeft, state.weightKg, now);
  let next: ScreenState = { ...state, truckLeft: watch.state, truckLeftSecondsLeft: watch.secondsLeft };
  if (watch.left) {
    next = { ...next, cancelling: true };
    return { state: next, effects: [{ type: "log", event: "truckLeft", data: { exceptionId: exception.id } }, { type: "cancel", exceptionId: exception.id, reason: "TRUCK_LEFT" }] };
  }
  // without a reading there is nothing true to send; the API cancels by itself after 10 s of silence
  if (heartbeat.inFlight || now < heartbeat.nextAt || state.weightKg === null) return { state: next, effects: [] };
  next = { ...next, heartbeat: { nextAt: now + SCREEN.heartbeatMs, inFlight: true } };
  return { state: next, effects: [{ type: "heartbeat", exceptionId: exception.id, weightKg: state.weightKg }] };
}

function notSavedReason(answer: HeartbeatAnswer): NotSavedReason {
  if (answer.status === "REJECTED") return "REJECTED";
  if (answer.status === "RETRY" && (answer.decision === "ADD_LOAD" || answer.decision === "REDUCE_LOAD")) return answer.decision;
  if (answer.status === "CANCELLED" || answer.status === "EXPIRED") return "CANCELLED";
  return "OTHER";
}

function onHeartbeatAnswer(state: ScreenState, exceptionId: number, answer: HeartbeatAnswer, now: number): Step {
  if (state.phase !== "waiting" || state.exception?.id !== exceptionId) return { state, effects: [] };
  if (answer.result === "SAVED" && answer.weighing) {
    return finish(state, "decided", { kind: "SAVED", weighing: answer.weighing, trip: answer.trip ?? null, afterDecision: true }, answer.message, answer.speech, now);
  }
  if (answer.result === "PENDING" && answer.exception) {
    // an approved plate: the next check asks for its own decision
    const next = enter(state, "waiting", now, {
      exception: answer.exception,
      heartbeat: { nextAt: now + SCREEN.heartbeatMs, inFlight: false },
      truckLeft: initialTruckLeft(),
      truckLeftSecondsLeft: null,
      message: answer.message,
    });
    return { state: next, effects: speak(answer.speech) };
  }
  if (answer.status === "PENDING") {
    return { state: { ...state, heartbeat: state.heartbeat ? { ...state.heartbeat, inFlight: false } : null }, effects: [] };
  }
  return finish(state, "decided", { kind: "NOT_SAVED", reason: notSavedReason(answer) }, answer.message, answer.speech, now);
}

function onHeartbeatFailed(state: ScreenState, exceptionId: number, failure: ApiFailure, now: number): Step {
  if (state.phase !== "waiting" || state.exception?.id !== exceptionId) return { state, effects: [] };
  // no answer: keep waiting and try again at the next beat
  if (failure.kind === "network") return { state: { ...state, heartbeat: state.heartbeat ? { ...state.heartbeat, inFlight: false } : null }, effects: [] };
  return finish(state, "decided", { kind: "NOT_SAVED", reason: "OTHER" }, failure.message, failure.speech, now);
}

function onCancelAnswer(state: ScreenState, exceptionId: number, answer: CancelAnswer, now: number): Step {
  if (state.phase !== "waiting" || state.exception?.id !== exceptionId) return { state, effects: [] };
  return finish(state, "decided", { kind: "NOT_SAVED", reason: "TRUCK_LEFT" }, answer.message, answer.speech, now);
}

function onCancelFailed(state: ScreenState, exceptionId: number, failure: ApiFailure, now: number): Step {
  if (state.phase !== "waiting" || state.exception?.id !== exceptionId) return { state, effects: [] };
  if (failure.kind === "api" && failure.code === "ALREADY_DECIDED") {
    // the decision came just before the truck left: ask for it and show it
    const next = { ...state, heartbeat: { nextAt: now + SCREEN.heartbeatMs, inFlight: true } };
    return { state: next, effects: [{ type: "heartbeat", exceptionId, weightKg: Math.max(0, state.weightKg ?? 0) }] };
  }
  return finish(state, "decided", { kind: "NOT_SAVED", reason: "TRUCK_LEFT" }, TEXT.truckLeft.message, TEXT.truckLeft.speech, now);
}

function onTick(state: ScreenState, now: number, env: ScreenEnv): Step {
  switch (state.phase) {
    case "truck":
    case "settling":
    case "countdown":
      return tickWeighing(state, now, env);
    case "plateRetry":
      if (state.plateRetryUntil !== null && now >= state.plateRetryUntil) {
        return tickWeighing(enter(state, "settling", now, { plateRetryUntil: null, stability: initialStability() }), now, env);
      }
      return { state, effects: [] };
    case "sending":
      return tickSending(state, now);
    case "waiting":
      return tickWaiting(state, now);
    case "saved":
    case "decided":
    case "refused":
      if (state.holdUntil !== null && now >= state.holdUntil) return { state: toIdle(state, now), effects: [] };
      return { state, effects: [] };
    default:
      return { state, effects: [] };
  }
}

export function reduceScreen(state: ScreenState, event: ScreenEvent, env: ScreenEnv): Step {
  switch (event.type) {
    case "card":
      return onCard(state, event.uid, event.now);
    case "cardAnswer":
      return onCardAnswer(state, event.uid, event.answer, event.now);
    case "cardFailed":
      if (state.phase !== "lookup" || state.cardUid !== event.uid) return { state, effects: [] };
      return refuse(state, event.failure, event.now);
    case "weight":
      return { state: { ...state, weightKg: event.weightKg }, effects: [] };
    case "plate":
      return { state: { ...state, cameraPlate: event.text }, effects: [] };
    case "manualPlate":
      return { state: { ...state, manualPlate: event.text && event.text.trim() ? event.text.trim().toUpperCase() : null }, effects: [] };
    case "tick":
      return onTick(state, event.now, env);
    case "weighAnswer":
      return onWeighAnswer(state, event.requestId, event.answer, event.now);
    case "weighFailed":
      return onWeighFailed(state, event.requestId, event.failure, event.now);
    case "heartbeatAnswer":
      return onHeartbeatAnswer(state, event.exceptionId, event.answer, event.now);
    case "heartbeatFailed":
      return onHeartbeatFailed(state, event.exceptionId, event.failure, event.now);
    case "cancelAnswer":
      return onCancelAnswer(state, event.exceptionId, event.answer, event.now);
    case "cancelFailed":
      return onCancelFailed(state, event.exceptionId, event.failure, event.now);
  }
}
