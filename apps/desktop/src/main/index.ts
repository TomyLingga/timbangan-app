// The Electron main process: one full-screen window, the scale, the API, the plate reader, settings and the log.
// The window gets a narrow bridge (see preload) and loads nothing from the network.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, safeStorage, screen, session } from "electron";
import type { DisplaySettings, SaveResult, ScreenView, Settings, SettingsForm, SettingsInput, StationView, UnlockPurpose, UnlockResult } from "../shared/bridge";
import { type ApiClient, createApiClient } from "./api-client";
import { createCctvPoller } from "./cctv";
import { createDailyLog } from "./daily-log";
import { createCapture, runDemo } from "./demo";
import { createPlateReader } from "./plate-reader";
import type { ScaleReader } from "./scale/reader";
import { createSerialScale, loadSerialPort } from "./scale/serial";
import { createSimulatorScale, type SimulatorScale } from "./scale/simulator";
import { createTcpScale } from "./scale/tcp";
import { createSettingsStore, parseSettings, type SecretCodec, toggleTheme } from "./settings";
import { speechAudioFor } from "./speech";
import { createStation, type Station } from "./station";
import { stationWebPreferences } from "./window-options";

const DEMO = !app.isPackaged && process.argv.includes("--demo");
/** The key of dev/fake-api-server.mts; used only by the demo run. */
const DEMO_STATION_KEY = "st1.development-only-key-for-the-fake-api-000000000";
const DEMO_API = `http://localhost:${process.env.FAKE_API_PORT ?? 4010}`;
/** Demo only: "1366x768" sizes the page, and with a capture folder the window renders off screen at that size. */
const DEMO_SIZE = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.DESKTOP_WINDOW ?? "");
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
let settingsUnlockedUntil = 0;

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

const display = (): DisplaySettings => ({
  stationName: settings.stationName,
  notice: settings.notice,
  theme: settings.theme,
  cctvConfigured: [Boolean(settings.cctvUrls[0]), Boolean(settings.cctvUrls[1])],
});
const screenView = (view: StationView): ScreenView => ({ ...view, display: display() });

let onViewExtra: ((view: ScreenView) => void) | null = null;
const publish = (view: StationView) => {
  const full = screenView(view);
  send("station:view", full);
  onViewExtra?.(full);
};

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
    onView: publish,
    onSpeak: (segments) => send("station:speak", segments),
  });
  station.start();
  ticker = setInterval(() => station?.tick(), TICK_MS);
  cctv = createCctvPoller({ urls: settings.cctvUrls, onFrame: (index, jpeg) => send("station:cctv", { index, jpeg }) });
  cctv.start();
  log.write("start", { apiBaseUrl: settings.apiBaseUrl, plateReaderUrl: settings.plateReaderUrl, scale: settings.scale, keyProtected, hasKey: stationKey !== null, version: app.getVersion() });
}

/** Saves settings that need no restart of the station (theme), or everything, and tells the window. */
async function saveSettings(next: Settings, key: string | null | undefined): Promise<void> {
  if (!DEMO) {
    await store.save(next, key);
    const loaded = await store.load();
    settings = loaded.settings;
    stationKey = loaded.stationKey;
    keyProtected = loaded.keyProtected;
  } else {
    settings = next;
  }
}

/** Only the program's own window may call the bridge. */
const fromWindow = (event: IpcMainInvokeEvent | IpcMainEvent) => window !== null && event.sender === window.webContents;
/** First setup: without a station key the API cannot check a PIN, so settings open without one. */
const settingsOpen = () => stationKey === null || Date.now() < settingsUnlockedUntil;

function registerIpc(): void {
  ipcMain.handle("station:ready", (event) => (fromWindow(event) && station ? screenView(station.view()) : null));

  ipcMain.handle("speech:audio", (event, text: unknown) => (fromWindow(event) ? speechAudioFor(api, text) : null));

  ipcMain.handle("settings:needPin", (event) => !fromWindow(event) || stationKey !== null);

  ipcMain.handle("pin:unlock", async (event, pin: unknown, purpose: unknown): Promise<UnlockResult> => {
    if (!fromWindow(event) || (purpose !== "settings" && purpose !== "manualPlate")) return { ok: false, message: "Permintaan tidak dikenal." };
    if (typeof pin !== "string" || !/^[0-9]{4,8}$/.test(pin)) return { ok: false, message: "PIN harus 4 sampai 8 angka." };
    // the API's manual-plate route is the PIN check it offers; it also opens settings
    if (!api || !station) return { ok: false, message: "Program belum siap." };
    const result = await api.checkPin(pin);
    if (result.ok) {
      if (purpose === "settings") settingsUnlockedUntil = Date.now() + UNLOCK_MS;
      else station.setExceptionMode(true);
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
    const parsed = parseSettings({ ...input, theme: settings.theme });
    const newKey = typeof input?.stationKey === "string" && input.stationKey.trim() ? input.stationKey.trim() : undefined;
    if (newKey !== undefined && !/^st[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{43}$/.test(newKey)) parsed.errors.push({ field: "stationKey", message: "Kunci stasiun tidak sesuai bentuknya." });
    if (parsed.errors.length) return { ok: false, message: "Periksa isian yang ditandai.", errors: parsed.errors };
    if (DEMO) return { ok: false, message: "Mode demo tidak menyimpan pengaturan.", errors: [] };
    await saveSettings(parsed.settings, newKey);
    settingsUnlockedUntil = 0;
    log.write("settingsSaved", { apiBaseUrl: settings.apiBaseUrl, plateReaderUrl: settings.plateReaderUrl, scale: settings.scale, keyChanged: newKey !== undefined, keyProtected });
    await startStation();
    return { ok: true };
  });

  // the theme is a matter of daylight, not of security: no PIN
  ipcMain.handle("theme:toggle", async (event) => {
    if (!fromWindow(event) || !station) return;
    await saveSettings({ ...settings, theme: toggleTheme(settings.theme) }, undefined);
    log.write("theme", { theme: settings.theme });
    publish(station.view());
  });

  ipcMain.handle("plate:manual", (event, plate: unknown) => {
    if (!fromWindow(event) || !station?.view().exceptionMode) return false;
    const text = typeof plate === "string" ? plate.trim().slice(0, 20) : null;
    station.manualPlate(text || null);
    return true;
  });

  ipcMain.handle("exception:end", (event) => {
    if (fromWindow(event)) station?.setExceptionMode(false);
  });

  ipcMain.handle("station:reset", (event) => {
    if (fromWindow(event)) station?.reset();
  });

  ipcMain.on("input:typing", (event, active: unknown) => {
    if (fromWindow(event)) typing = active === true;
  });
}

function createWindow(): BrowserWindow {
  const offscreen = DEMO && Boolean(DEMO_SIZE) && Boolean(process.env.DESKTOP_CAPTURE_DIR);
  const pageWidth = DEMO_SIZE ? Number(DEMO_SIZE[1]) : 1600;
  const pageHeight = DEMO_SIZE ? Number(DEMO_SIZE[2]) : 900;
  // Windows keeps a window inside the display; a page larger than this display is shown zoomed out, so the page
  // still lays out at exactly the asked size
  const area = screen.getPrimaryDisplay().workAreaSize;
  const zoom = DEMO_SIZE ? Math.min(1, (area.width - 16) / pageWidth, (area.height - 16) / pageHeight) : 1;
  const win = new BrowserWindow({
    width: Math.floor(pageWidth * zoom),
    height: Math.floor(pageHeight * zoom),
    useContentSize: true,
    fullscreen: app.isPackaged,
    autoHideMenuBar: true,
    backgroundColor: settings.theme === "light" ? "#f4f7f6" : "#0b100f",
    show: false,
    title: "Timbangan",
    webPreferences: {
      ...stationWebPreferences(join(__dirname, "../preload/index.js")),
      devTools: !app.isPackaged,
      // demo screenshots at an exact page size, whatever the size of this computer's display
      offscreen,
      zoomFactor: zoom,
    },
  });
  win.removeMenu();
  if (!offscreen) win.once("ready-to-show", () => win.show());

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
    const theme = process.env.DESKTOP_THEME === "light" ? "light" : process.env.DESKTOP_THEME === "dark" ? "dark" : settings.theme;
    const exitCamera = process.env.DESKTOP_DEMO_CCTV_OUT ?? "2";
    settings = {
      ...settings,
      apiBaseUrl: DEMO_API,
      plateReaderUrl: DEMO_API,
      cctvUrls: [`${DEMO_API}/__dev/cctv/1.jpg`, `${DEMO_API}/__dev/cctv/${exitCamera}.jpg`],
      stationName: "Jalur 1",
      theme,
      scale: { ...settings.scale, driver: "simulator" },
    };
    stationKey = DEMO_STATION_KEY;
  }

  // say in the log whether the native serial module loads in this Electron, whatever driver is set
  void loadSerialPort().then((serial) => {
    const entry = "error" in serial ? { available: false, error: serial.error } : { available: true };
    log.write("serialModule", entry);
    if (!app.isPackaged) console.log("serial module:", JSON.stringify(entry));
  });

  registerIpc();
  window = createWindow();
  await startStation();

  if (DEMO) {
    const captureDir = process.env.DESKTOP_CAPTURE_DIR;
    if (captureDir) {
      const capture = createCapture(window, captureDir, { prefix: DEMO_SIZE ? `${DEMO_SIZE[1]}x${DEMO_SIZE[2]}-` : "", suffix: `-${settings.theme}` });
      onViewExtra = (view) => capture.onView(view);
    }
    window.webContents.once("did-finish-load", () => {
      const contents = window?.webContents;
      setTimeout(() => void contents?.executeJavaScript("[innerWidth, innerHeight]").then((size) => console.log("page size:", JSON.stringify(size))), 1_000);
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
