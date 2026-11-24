// The web preferences of the station window, kept apart from index.ts so the speech check (dev/speech-check)
// opens its window with exactly the same ones.
import type { WebPreferences } from "electron";

/**
 * Sandboxed, isolated, no Node in the page. `autoplayPolicy` lets the window start Web Audio without a click or a
 * key press in it: the program speaks to a driver while nobody touches the computer.
 */
export function stationWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    autoplayPolicy: "no-user-gesture-required",
  };
}
