// The Electron main process: one full-screen window, the scale, the API, the plate reader, settings and the log.
// The window gets a narrow bridge (see preload) and loads nothing from the network.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, safeStorage, session } from "electron";
import type { SaveResult, Settings, SettingsForm, SettingsInput, StationView, UnlockPurpose, UnlockResult } from "../shared/bridge";
import { type ApiClient, createApiClient } from "./api-client";
import { createCctvPoller } from "./cctv";
import { createDailyLog } from "./daily-log";
import { createCapture, runDemo } from "./demo";
import { createPlateReader } from "./plate-reader";
import type { ScaleReader } from "./scale/reader";
import { createSerialScale, loadSerialPort } from "./scale/serial";
import { createSimulatorScale, type SimulatorScale } from "./scale/simulator";
import { createTcpScale } from "./scale/tcp";
import { createSettingsStore, parseSettings, type SecretCodec } from "./settings";
import { createStation, type Station } from "./station";

const DEMO = !app.isPackaged && process.argv.includes("--demo");
/** The key of dev/fake-api-server.mts; used only by the demo run. */
const DEMO_STATION_KEY = "st1.development-only-key-for-the-fake-api-000000000";
const DEMO_API = `http://localhost:${process.env.FAKE_API_PORT ?? 4010}`;
const UNLOCK_MS = 5 * 60_000;
const TICK_MS = 100;

const codec: SecretCodec = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
};

let window: BrowserWindow | null = null;
let station: Station | null = null;
let api: ApiClient | null = null;
let scale: ScaleReader | null = null;
let cctv: ReturnType<typeof createCctvPoller> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let settings: Settings;
let stationKey: string | null = null;
let keyProtected = false;
let typing = false;
const unlockedUntil: Record<UnlockPurpose, number> = { settings: 0, manualPlate: 0 };

const log = createDailyLog(join(app.getPath("userData"), "logs"), () => Date.now());
const store = createSettingsStore(app.getPath("userData"), codec);

function scaleFor(current: Settings): ScaleReader {
  const options = current.scale;
  if (options.driver === "tcp") return createTcpScale({ host: options.host, port: options.port });
  if (options.driver === "serial") return createSerialScale({ path: options.serialPath, baudRate: options.baudRate, dataBits: options.dataBits, parity: options.parity, stopBits: options.stopBits });
  return createSimulatorScale();
}

function send(channel: string, value: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

let onViewExtra: ((view: StationView) => void) | null = null;

async function startStation(): Promise<void> {
  if (ticker) clearInterval(ticker);
  cctv?.stop();
  await station?.stop();
  scale = scaleFor(settings);
  const client = createApiClient({
    baseUrl: settings.apiBaseUrl,
    stationKey: stationKey ?? "",
    onCall: (entry) => log.write("api", { ...entry }),
  });
  api = client;
  station = createStation({
    api: client,
    plateReader: settings.plateReaderUrl ? createPlateReader({ baseUrl: settings.plateReaderUrl }) : null,
    scale,
    now: () => Date.now(),
    newRequestId: () => randomUUID(),
    log,
    onView: (view) => {
      send("station:view", view);
      onViewExtra?.(view);
    },
    onSpeak: (segments) => send("station:speak", segments),
  });
  station.start();
  ticker = setInterval(() => station?.tick(), TICK_MS);
  cctv = createCctvPoller({ urls: settings.cctvUrls, onFrame: (index, jpeg) => send("station:cctv", { index, jpeg }) });
  cctv.start();
  log.write("start", { apiBaseUrl: settings.apiBaseUrl, plateReaderUrl: settings.plateReaderUrl, scale: settings.scale, keyProtected, hasKey: stationKey !== null, version: app.getVersion() });
}

/** Only the program's own window may call the bridge. */
const fromWindow = (event: IpcMainInvokeEvent | IpcMainEvent) => window !== null && event.sender === window.webContents;
const unlocked = (purpose: UnlockPurpose) => Date.now() < unlockedUntil[purpose];
/** First setup: without a station key the API cannot check a PIN, so settings open without one. */
const settingsOpen = () => stationKey === null || unlocked("settings");

function registerIpc(): void {
  ipcMain.handle("station:ready", (event) => (fromWindow(event) && station ? station.view() : null));

  ipcMain.handle("speech:audio", async (event, text: unknown) => {
    if (!fromWindow(event) || typeof text !== "string" || !text.trim() || text.length > 300 || !api) return null;
    return api.speechAudio(text);
  });

  ipcMain.handle("settings:needPin", (event) => !fromWindow(event) || stationKey !== null);

  ipcMain.handle("pin:unlock", async (event, pin: unknown, purpose: unknown): Promise<UnlockResult> => {
    if (!fromWindow(event) || (purpose !== "settings" && purpose !== "manualPlate")) return { ok: false, message: "Permintaan tidak dikenal." };
    if (typeof pin !== "string" || !/^[0-9]{4,8}$/.test(pin)) return { ok: false, message: "PIN harus 4 sampai 8 angka." };
    // the API's manual-plate route is the PIN check it offers; it also opens settings
    if (!api) return { ok: false, message: "Program belum siap." };
    const result = await api.checkPin(pin);
    if (result.ok) {
      unlockedUntil[purpose] = Date.now() + UNLOCK_MS;
      log.write("unlock", { purpose });
      return { ok: true };
    }
    log.write("unlockRefused", { purpose, code: result.failure.kind === "api" ? result.failure.code : "NETWORK" });
    return { ok: false, message: result.failure.kind === "api" ? result.failure.message : "Server tidak menjawab." };
  });

  ipcMain.handle("settings:get", (event): SettingsForm | null => {
    if (!fromWindow(event) || !settingsOpen()) return null;
    return { ...settings, hasStationKey: stationKey !== null, keyProtected };
  });

  ipcMain.handle("settings:save", async (event, input: SettingsInput): Promise<SaveResult> => {
    if (!fromWindow(event) || !settingsOpen()) return { ok: false, message: "Buka pengaturan dengan PIN dulu.", errors: [] };
    const phase = station?.view().screen.phase;
    if (phase === "sending" || phase === "waiting") return { ok: false, message: "Tunggu sampai timbang selesai.", errors: [] };
    const parsed = parseSettings(input);
    const newKey = typeof input?.stationKey === "string" && input.stationKey.trim() ? input.stationKey.trim() : undefined;
    if (newKey !== undefined && !/^st[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{43}$/.test(newKey)) parsed.errors.push({ field: "stationKey", message: "Kunci stasiun tidak sesuai bentuknya." });
    if (parsed.errors.length) return { ok: false, message: "Periksa isian yang ditandai.", errors: parsed.errors };
    if (DEMO) return { ok: false, message: "Mode demo tidak menyimpan pengaturan.", errors: [] };
    await store.save(parsed.settings, newKey);
    const loaded = await store.load();
    settings = loaded.settings;
    stationKey = loaded.stationKey;
    keyProtected = loaded.keyProtected;
    unlockedUntil.settings = 0;
    log.write("settingsSaved", { apiBaseUrl: settings.apiBaseUrl, plateReaderUrl: settings.plateReaderUrl, scale: settings.scale, keyChanged: newKey !== undefined, keyProtected });
    await startStation();
    return { ok: true };
  });

  ipcMain.handle("plate:manual", (event, plate: unknown) => {
    if (!fromWindow(event) || !unlocked("manualPlate") || !station) return false;
    const text = typeof plate === "string" ? plate.trim().slice(0, 20) : null;
    station.manualPlate(text || null);
    return true;
  });

  ipcMain.on("input:typing", (event, active: unknown) => {
    if (fromWindow(event)) typing = active === true;
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    fullscreen: app.isPackaged,
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    show: false,
    title: "Timbangan",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.removeMenu();
  win.once("ready-to-show", () => win.show());

  // stay on the program's own page; open nothing else
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  // keys typed anywhere in the window: the RFID reader types the card UID and Enter
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || !station) return;
    if (scale && "set" in scale && !app.isPackaged) {
      const simulator = scale as SimulatorScale;
      if (input.key === "F6") simulator.set(41_500);
      if (input.key === "F7") simulator.set(simulator.get() + (Math.random() < 0.5 ? -20 : 20));
      if (input.key === "F8") simulator.set(0);
    }
    if (!typing) station.key(input.key);
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

app.whenReady().then(async () => {
  // the window asks for nothing: no camera, microphone, notifications or other permissions
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const loaded = await store.load();
  settings = loaded.settings;
  stationKey = loaded.stationKey;
  keyProtected = loaded.keyProtected;
  if (DEMO) {
    settings = { ...settings, apiBaseUrl: DEMO_API, plateReaderUrl: DEMO_API, cctvUrls: [], scale: { ...settings.scale, driver: "simulator" } };
    stationKey = DEMO_STATION_KEY;
  }

  // say in the log whether the native serial module loads in this Electron, whatever driver is set
  void loadSerialPort().then((loaded) => {
    const entry = "error" in loaded ? { available: false, error: loaded.error } : { available: true };
    log.write("serialModule", entry);
    if (!app.isPackaged) console.log("serial module:", JSON.stringify(entry));
  });

  registerIpc();
  window = createWindow();
  await startStation();

  if (DEMO) {
    const captureDir = process.env.DESKTOP_CAPTURE_DIR;
    if (captureDir) {
      const capture = createCapture(window, captureDir);
      onViewExtra = (view) => capture.onView(view);
    }
    const current = window;
    current.webContents.once("did-finish-load", () => {
      void runDemo({
        station: () => station as Station,
        scale: scale as SimulatorScale,
        apiBaseUrl: DEMO_API,
        onDone: () => app.quit(),
      });
    });
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (ticker) clearInterval(ticker);
  cctv?.stop();
  void station?.stop();
  void log.flush();
});
