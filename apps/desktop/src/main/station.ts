// The weighbridge station in the main process: runs the screen state machine and carries out its effects with the
// scale reader, the API client and the plate reader. Has no Electron dependency, so it runs in tests with a
// simulated scale, a fake API and a clock the test moves. The caller drives `tick` (every 100 ms in the program).
import { CAMERA_COUNT, initialCameras, onlineCount, recordCamera } from "../shared/cameras";
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
  /** The operator's reset: cancel the current weighing, wait for a card. */
  reset(): void;
  setExceptionMode(on: boolean): void;
  view(): StationView;
  /** Resolves when no API or plate call is in flight (for tests). */
  settle(): Promise<void>;
}

export function createStation(deps: StationDeps): Station {
  const plateEveryMs = deps.plateEveryMs ?? 1_000;
  const healthEveryMs = deps.healthEveryMs ?? 30_000;
  let screen = initialScreen(deps.now());
  let cardInput = initialCardInput();
  const links: StationLinks = { scale: "connecting", scaleDetail: null, api: "unknown", platesOnline: deps.plateReader ? 0 : null };
  const inFlight = new Set<Promise<unknown>>();
  let cameras = initialCameras();
  let exceptionMode = false;
  /** The camera of the truck's stage, whose text is sent with the weighing. */
  let plateCamera: number | null = null;
  const cameraBusy = new Set<number>();
  let nextPlateAt = 0;
  let nextHealthAt = 0;
  let stopped = false;

  const view = (): StationView => ({ screen, links: { ...links }, cameras, exceptionMode });
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
      case "watchPlate": {
        plateCamera = effect.camera;
        // the newest reading of that camera counts at once
        const current = cameras.find((reading) => reading.camera === effect.camera);
        if (current?.plate) queueMicrotask(() => plateCamera === effect.camera && dispatch({ type: "plate", text: current.plate }));
        return;
      }
      case "log":
        deps.log.write(effect.event, effect.data);
        return;
    }
  }

  /** All four cameras once a second, each with at most one call out. */
  function pollPlates(now: number): void {
    const reader = deps.plateReader;
    if (!reader || now < nextPlateAt) return;
    nextPlateAt = now + plateEveryMs;
    for (let camera = 1; camera <= CAMERA_COUNT; camera++) {
      if (cameraBusy.has(camera)) continue;
      cameraBusy.add(camera);
      track(
        reader.read(camera).then((read) => {
          cameraBusy.delete(camera);
          cameras = recordCamera(cameras, camera, read, deps.now());
          links.platesOnline = onlineCount(cameras);
          // the stage camera may have changed or stopped while the call was out
          if (plateCamera === camera) dispatch({ type: "plate", text: read && read.plate ? read.plate : null });
          else publish();
        }),
      );
    }
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
      pollPlates(now);
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
    reset() {
      dispatch({ type: "reset", now: deps.now() });
    },
    setExceptionMode(on: boolean) {
      exceptionMode = on;
      deps.log.write("exceptionMode", { on });
      if (!on) dispatch({ type: "manualPlate", text: null });
      else publish();
    },
    view,
    async settle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
