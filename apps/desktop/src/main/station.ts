// The weighbridge station in the main process: runs the screen state machine and carries out its effects with the
// scale reader, the API client and the plate reader. Has no Electron dependency, so it runs in tests with a
// simulated scale, a fake API and a clock the test moves. The caller drives `tick` (every 100 ms in the program).
import { feedCardKey, initialCardInput, normaliseCardUid } from "../shared/card-input";
import { type Effect, initialScreen, reduceScreen, type ScreenEvent } from "../shared/screen";
import type { ApiClient, ApiResult } from "./api-client";
import type { DailyLog } from "./daily-log";
import type { PlateReader } from "./plate-reader";
import type { ScaleReader } from "./scale/reader";
import type { StationLinks, StationView } from "../shared/bridge";

export type { StationLinks, StationView };

export interface StationDeps {
  api: ApiClient;
  plateReader: PlateReader | null;
  scale: ScaleReader;
  now(): number;
  newRequestId(): string;
  log: DailyLog;
  onView(view: StationView): void;
  onSpeak(segments: string[]): void;
  plateEveryMs?: number;
  healthEveryMs?: number;
}

export interface Station {
  start(): void;
  stop(): Promise<void>;
  tick(): void;
  /** A key pressed anywhere in the window; card readers type their UID and Enter. */
  key(key: string): void;
  /** A card read some other way (development keys). */
  card(uid: string): void;
  manualPlate(text: string | null): void;
  view(): StationView;
  /** Resolves when no API or plate call is in flight (for tests). */
  settle(): Promise<void>;
}

export function createStation(deps: StationDeps): Station {
  const plateEveryMs = deps.plateEveryMs ?? 1_000;
  const healthEveryMs = deps.healthEveryMs ?? 30_000;
  let screen = initialScreen(deps.now());
  let cardInput = initialCardInput();
  const links: StationLinks = { scale: "connecting", scaleDetail: null, api: "unknown", plate: deps.plateReader ? "unknown" : "off" };
  const inFlight = new Set<Promise<unknown>>();
  let plateCamera: number | null = null;
  let plateBusy = false;
  let nextPlateAt = 0;
  let nextHealthAt = 0;
  let stopped = false;

  const view = (): StationView => ({ screen, links: { ...links } });
  const publish = () => deps.onView(view());

  const track = <T>(promise: Promise<T>) => {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
    return promise;
  };

  /** Notes whether the API answered at all. */
  const sawApi = (result: ApiResult<unknown>) => {
    links.api = result.ok || result.failure.kind === "api" ? "ok" : "down";
  };

  function dispatch(event: ScreenEvent): void {
    if (stopped) return;
    const before = screen.phase;
    const step = reduceScreen(screen, event, { newRequestId: deps.newRequestId });
    screen = step.state;
    if (screen.phase !== before) deps.log.write("phase", { from: before, to: screen.phase, message: screen.message });
    for (const effect of step.effects) run(effect);
    publish();
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case "lookupCard":
        track(
          deps.api.lookupCard(effect.uid).then((result) => {
            sawApi(result);
            dispatch(result.ok ? { type: "cardAnswer", uid: effect.uid, answer: result.body, now: deps.now() } : { type: "cardFailed", uid: effect.uid, failure: result.failure, now: deps.now() });
          }),
        );
        return;
      case "weigh":
        track(
          deps.api.weigh({ cardUid: effect.cardUid, weightKg: effect.weightKg, plateRead: effect.plateRead, requestId: effect.requestId }).then((result) => {
            sawApi(result);
            dispatch(result.ok ? { type: "weighAnswer", requestId: effect.requestId, answer: result.body, now: deps.now() } : { type: "weighFailed", requestId: effect.requestId, failure: result.failure, now: deps.now() });
          }),
        );
        return;
      case "heartbeat":
        track(
          deps.api.heartbeat(effect.exceptionId, effect.weightKg).then((result) => {
            sawApi(result);
            dispatch(result.ok ? { type: "heartbeatAnswer", exceptionId: effect.exceptionId, answer: result.body, now: deps.now() } : { type: "heartbeatFailed", exceptionId: effect.exceptionId, failure: result.failure, now: deps.now() });
          }),
        );
        return;
      case "cancel":
        track(
          deps.api.cancel(effect.exceptionId, effect.reason).then((result) => {
            sawApi(result);
            dispatch(result.ok ? { type: "cancelAnswer", exceptionId: effect.exceptionId, answer: result.body, now: deps.now() } : { type: "cancelFailed", exceptionId: effect.exceptionId, failure: result.failure, now: deps.now() });
          }),
        );
        return;
      case "speak":
        deps.log.write("speak", { text: effect.segments.join(" ") });
        deps.onSpeak(effect.segments);
        return;
      case "watchPlate":
        plateCamera = effect.camera;
        nextPlateAt = 0;
        return;
      case "log":
        deps.log.write(effect.event, effect.data);
        return;
    }
  }

  function pollPlate(now: number): void {
    const reader = deps.plateReader;
    if (!reader || plateCamera === null || plateBusy || now < nextPlateAt) return;
    const camera = plateCamera;
    plateBusy = true;
    nextPlateAt = now + plateEveryMs;
    track(
      reader.read(camera).then((read) => {
        plateBusy = false;
        links.plate = read ? read.status : "down";
        // the camera may have changed or stopped while the call was out
        if (plateCamera === camera) dispatch({ type: "plate", text: read && read.plate ? read.plate : null });
        else publish();
      }),
    );
  }

  function checkHealth(now: number): void {
    if (now < nextHealthAt) return;
    nextHealthAt = now + healthEveryMs;
    track(
      deps.api.health().then((up) => {
        links.api = up ? "ok" : "down";
        publish();
      }),
    );
  }

  return {
    start() {
      stopped = false;
      deps.scale.start({
        weight: (kg) => dispatch({ type: "weight", weightKg: kg }),
        status: (status, detail) => {
          links.scale = status;
          links.scaleDetail = detail ?? null;
          deps.log.write("scale", { status, detail: detail ?? null });
          // a scale that is not connected gives no weight; never keep an old one
          if (status !== "connected") dispatch({ type: "weight", weightKg: null });
          else publish();
        },
      });
      publish();
    },
    async stop() {
      stopped = true;
      await deps.scale.stop();
      await Promise.allSettled([...inFlight]);
    },
    tick() {
      const now = deps.now();
      checkHealth(now);
      pollPlate(now);
      dispatch({ type: "tick", now });
    },
    key(key: string) {
      const step = feedCardKey(cardInput, key, deps.now());
      cardInput = step.state;
      if (step.card) {
        deps.log.write("card", { uid: step.card });
        dispatch({ type: "card", uid: step.card, now: deps.now() });
      }
    },
    card(uid: string) {
      const clean = normaliseCardUid(uid);
      if (clean) dispatch({ type: "card", uid: clean, now: deps.now() });
    },
    manualPlate(text: string | null) {
      deps.log.write("manualPlate", { plate: text });
      dispatch({ type: "manualPlate", text });
    },
    view,
    async settle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
