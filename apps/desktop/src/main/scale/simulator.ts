// A pretend scale indicator for development and tests. It writes the same kind of text lines a real indicator
// sends ("ST,GS 99 41500 kg") through the same parser, a few times a second. The weight is set by keys in
// development, or by a script of timed steps.
import { createFrameParser } from "../../shared/scale-frame";
import type { ScaleListener, ScaleReader } from "./reader";

export interface SimulatorScale extends ScaleReader {
  set(kg: number): void;
  get(): number;
  /** Runs timed steps: each sets a weight after `afterMs` from the previous step. */
  play(steps: { afterMs: number; kg: number }[]): void;
}

export function createSimulatorScale(options: { intervalMs?: number; startKg?: number } = {}): SimulatorScale {
  const intervalMs = options.intervalMs ?? 200;
  const parser = createFrameParser();
  let weight = options.startKg ?? 0;
  let listener: ScaleListener | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let steps: ReturnType<typeof setTimeout>[] = [];

  const emit = () => {
    if (!listener) return;
    for (const kg of parser.push(`ST,GS 99 ${String(Math.max(0, weight)).padStart(6, "0")} kg\r\n`)) listener.weight(kg);
  };

  return {
    start(next) {
      listener = next;
      next.status("connecting");
      next.status("connected", "simulator");
      emit();
      ticker = setInterval(emit, intervalMs);
    },
    async stop() {
      if (ticker) clearInterval(ticker);
      for (const step of steps) clearTimeout(step);
      steps = [];
      ticker = null;
      listener = null;
    },
    set(kg) {
      weight = Math.round(kg);
      emit();
    },
    get: () => weight,
    play(list) {
      let at = 0;
      for (const step of list) {
        at += step.afterMs;
        steps.push(setTimeout(() => this.set(step.kg), at));
      }
    },
  };
}
