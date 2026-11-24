// Main process of the speech check, started by dev/speech-check.mts. It opens a hidden window with the program's
// own web preferences and preload, answers `speech:audio` the way the program does (real API client, real guard),
// asks the API for a real refusal sentence, then lets the page speak a few rounds and prints what happened as one
// JSON line. Settings and the station key of the program are not read: the key comes from the runner.
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, type WebPreferences } from "electron";
import { createApiClient } from "../../src/main/api-client";
import { speechAudioFor } from "../../src/main/speech";
import { stationWebPreferences } from "../../src/main/window-options";
import type { CheckOutput, FetchRecord, PageResult } from "./marks";

const apiBaseUrl = process.env.SPEECH_CHECK_API ?? "http://localhost:3100";
const stationKey = process.env.SPEECH_CHECK_STATION_KEY ?? "";
const audible = process.env.SPEECH_CHECK_AUDIBLE === "1";
const policyOverride = process.env.SPEECH_CHECK_AUTOPLAY_POLICY as WebPreferences["autoplayPolicy"] | undefined;
const roundsWanted = Math.max(1, Number(process.env.SPEECH_CHECK_ROUNDS ?? 2));
const timeoutMs = Number(process.env.SPEECH_CHECK_TIMEOUT_MS ?? 60_000);

// the laptop stays silent unless asked; Chromium still decodes and renders the audio, it only drops the output
if (!audible) app.commandLine.appendSwitch("mute-audio");
if (process.env.SPEECH_CHECK_USER_DATA) app.setPath("userData", process.env.SPEECH_CHECK_USER_DATA);

const DIGITS = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];
const random = (from: number, to: number) => from + Math.floor(Math.random() * (to - from + 1));
const thousands = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/**
 * Segments as the API writes them (src/weighing/speech.ts in the API). The plate and the weights are new on every
 * run, so the first round makes the API synthesise them; later rounds come from its cache. The third segment is
 * longer than the program sends to the API, so it has no audio and the queue must play the tone.
 */
function segmentsFor(refusal: string): string[] {
  const plate = `Plat B K ${[random(1, 9), random(0, 9), random(0, 9), random(0, 9)].map((digit) => DIGITS[digit]).join(" ")} U A.`;
  const weighed = random(40_100, 42_900);
  const weights = `Timbang ${thousands(weighed)} kilogram, surat ${thousands(weighed - random(300, 900))} kilogram.`;
  const noAudio = `Kalimat ini sengaja lebih panjang dari batas, jadi tidak ada suaranya. ${"Bagian pengisi. ".repeat(18)}`.trim();
  return [plate, weights, noAudio, refusal];
}

const output: CheckOutput = { apiBaseUrl, audible, autoplayPolicy: "", rounds: [], fetches: [], page: null, console: [] };
const finish = (code: number, error?: string) => {
  if (error) output.error = error;
  process.stdout.write(`SPEECH_CHECK_RESULT ${JSON.stringify(output)}\n`);
  app.exit(code);
};

app.whenReady().then(async () => {
  const guard = setTimeout(() => finish(2, "the check did not finish in time"), timeoutMs * (roundsWanted + 1) + 30_000);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const statuses = new Map<string, number[]>();
  const api = createApiClient({
    baseUrl: apiBaseUrl,
    stationKey,
    // the real client with a fetch that notes the status of each speech request, by its text
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(String(input));
      const text = url.searchParams.get("text");
      if (url.pathname === "/api/weighbridge/speech" && text !== null) statuses.set(text, [...(statuses.get(text) ?? []), response.status]);
      return response;
    },
  });

  // a real refusal answer of the API: an unknown card (the UID is not hexadecimal, so the API does not even look it up)
  const refused = await api.lookupCard("CEK-SUARA");
  if (refused.ok || refused.failure.kind !== "api" || refused.failure.speech.length === 0) {
    clearTimeout(guard);
    return finish(1, `no refusal from the API: ${refused.ok ? `HTTP ${refused.status}` : refused.failure.kind === "api" ? `HTTP ${refused.failure.status} ${refused.failure.code}` : refused.failure.message}`);
  }
  const segments = segmentsFor(refused.failure.speech[0] ?? "");
  output.rounds = Array.from({ length: roundsWanted }, () => segments);

  const preferences: WebPreferences = { ...stationWebPreferences(join(__dirname, "../preload/index.js")), devTools: false, backgroundThrottling: false };
  if (policyOverride) preferences.autoplayPolicy = policyOverride;
  output.autoplayPolicy = preferences.autoplayPolicy ?? "(Electron default)";
  // hidden, so the laptop shows nothing; background throttling is off so its timers run as in the shown program window
  const window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: preferences });
  window.webContents.on("console-message", (details) => output.console.push(`${details.level}: ${details.message}`));

  const seen = new Map<string, number>();
  ipcMain.handle("speech:audio", async (event, text: unknown) => {
    if (event.sender !== window.webContents) return null;
    const label = String(text);
    const round = seen.get(label) ?? 0;
    seen.set(label, round + 1);
    const before = statuses.get(label)?.length ?? 0;
    const started = performance.now();
    const audio = await speechAudioFor(api, text);
    const record: FetchRecord = { round, text: label, ms: Math.round(performance.now() - started), bytes: audio ? audio.byteLength : null, status: statuses.get(label)?.[before] ?? null };
    output.fetches.push(record);
    return audio;
  });

  try {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
    // userGesture false: the page gets no user activation, like the program before anyone touches it
    output.page = (await window.webContents.executeJavaScript(`window.speechCheck(${JSON.stringify(output.rounds)}, ${timeoutMs})`, false)) as PageResult;
    clearTimeout(guard);
    finish(0);
  } catch (error) {
    clearTimeout(guard);
    finish(1, error instanceof Error ? error.message : String(error));
  }
});
