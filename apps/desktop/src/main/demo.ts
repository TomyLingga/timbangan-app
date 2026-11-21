// Development only (`npm run demo`): drives the simulator and cards through the fake API's trucks, and can save a
// picture of the window at each new screen state. Never active in a packaged program.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { StationView } from "../shared/bridge";
import type { SimulatorScale } from "./scale/simulator";
import type { Station } from "./station";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saves a PNG of the window the first time each screen state shows, a moment after it appears. */
export function createCapture(window: BrowserWindow, dir: string, delayMs = 900) {
  const seen = new Set<string>();
  let count = 0;
  return {
    onView(view: StationView) {
      const screen = view.screen;
      const name = screen.phase === "decided" && screen.outcome?.kind === "SAVED" ? "decided-saved" : screen.phase;
      if (seen.has(name)) return;
      seen.add(name);
      const file = `${String(++count).padStart(2, "0")}-${name}.png`;
      setTimeout(() => {
        if (window.isDestroyed()) return;
        void window.webContents
          .capturePage()
          .then(async (image) => {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, file), image.toPNG());
          })
          .catch(() => undefined);
      }, delayMs);
    },
  };
}

/** The demo: a first weighing saved, one that waits for a decision and is approved, and an unknown card. */
export async function runDemo(options: { station: () => Station; scale: SimulatorScale; apiBaseUrl: string; onDone(): void }) {
  const setPlate = (plate: string) => fetch(`${options.apiBaseUrl}/__dev/plate/3`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plate }) }).catch(() => undefined);
  const { scale } = options;

  await wait(2_500);
  await setPlate("XX1234AB");
  options.station().card("0A1B2C3D4E");
  await wait(2_500);
  scale.play([
    { afterMs: 0, kg: 8_400 },
    { afterMs: 400, kg: 23_900 },
    { afterMs: 400, kg: 38_760 },
    { afterMs: 400, kg: 41_480 },
    { afterMs: 600, kg: 41_500 },
  ]);
  await wait(16_000);
  scale.set(0);
  await wait(2_000);

  await setPlate("YY5678CD");
  options.station().card("1A2B3C4D5E");
  await wait(2_000);
  scale.play([
    { afterMs: 0, kg: 12_000 },
    { afterMs: 500, kg: 39_000 },
    { afterMs: 500, kg: 41_500 },
  ]);
  await wait(24_000);
  scale.set(0);
  await wait(2_000);

  options.station().card("FFEEDDCCBB");
  await wait(4_000);
  options.onDone();
}
