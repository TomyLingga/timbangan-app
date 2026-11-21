// The narrow, typed bridge between the window and the main process. The window only displays and plays audio;
// everything else (devices, network, settings, log) stays in the main process.
import type { CameraReading } from "./cameras";
import type { ScreenState } from "./screen";

export type ScaleStatus = "connecting" | "connected" | "disconnected" | "unavailable";

export interface StationLinks {
  scale: ScaleStatus;
  scaleDetail: string | null;
  /** ok: the API answered the last call; down: it did not. */
  api: "unknown" | "ok" | "down";
  /** Plate cameras giving readings now, of four; null when no plate reader address is set. */
  platesOnline: number | null;
}

export interface StationView {
  screen: ScreenState;
  links: StationLinks;
  /** The latest reading of each of the four plate cameras. */
  cameras: CameraReading[];
  /** Manual plate entry is open (the Exception switch, after the station PIN). */
  exceptionMode: boolean;
}

/** What the window needs from the settings to draw the screen; no address and no key. */
export interface DisplaySettings {
  stationName: string;
  notice: string;
  theme: Theme;
  /** Whether the entry and the exit CCTV have an address. */
  cctvConfigured: [boolean, boolean];
}

export interface ScreenView extends StationView {
  display: DisplaySettings;
}

export interface ScaleSettings {
  driver: "tcp" | "serial" | "simulator";
  host: string;
  port: number;
  serialPath: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even" | "odd";
  stopBits: 1 | 2;
}

export type Theme = "dark" | "light";

export interface Settings {
  apiBaseUrl: string;
  plateReaderUrl: string;
  /** Two JPEG snapshot addresses in fixed places: [entry camera, exit camera]; an empty one is not shown. */
  cctvUrls: string[];
  scale: ScaleSettings;
  /** Shown after "Timbangan" in the title bar. */
  stationName: string;
  /** The "Perhatian" line at the bottom of the screen. */
  notice: string;
  theme: Theme;
}

export interface SettingsError {
  field: string;
  message: string;
}

/** What the settings screen shows. The station key itself never goes to the window. */
export interface SettingsForm extends Settings {
  hasStationKey: boolean;
  keyProtected: boolean;
}

/** What the settings screen sends back; `stationKey` empty keeps the stored key. */
export interface SettingsInput extends Settings {
  stationKey: string;
}

export type UnlockPurpose = "settings" | "manualPlate";
export type UnlockResult = { ok: true } | { ok: false; message: string };
export type SaveResult = { ok: true } | { ok: false; message: string; errors: SettingsError[] };

export interface CctvFrame {
  /** 0: entry camera, 1: exit camera. */
  index: number;
  jpeg: Uint8Array | null;
}

export interface DesktopBridge {
  onView(listener: (view: ScreenView) => void): () => void;
  onSpeak(listener: (segments: string[]) => void): () => void;
  onCctv(listener: (frame: CctvFrame) => void): () => void;
  /** Asks the main process for the current view (on load). */
  ready(): Promise<ScreenView | null>;
  /** The WAV of one segment from the API; null when there is none. */
  speechAudio(text: string): Promise<ArrayBuffer | null>;
  /** Whether settings open without the PIN (first setup: no station key yet). */
  settingsNeedPin(): Promise<boolean>;
  /** Checks the station PIN with the API (POST /api/weighbridge/manual-plate). */
  unlock(pin: string, purpose: UnlockPurpose): Promise<UnlockResult>;
  getSettings(): Promise<SettingsForm | null>;
  saveSettings(input: SettingsInput): Promise<SaveResult>;
  setManualPlate(plate: string | null): Promise<boolean>;
  /** Turns the Exception switch off; turning it on goes through `unlock(pin, "manualPlate")`. */
  endException(): Promise<void>;
  /** Cancels the current weighing and waits for a card again. */
  reset(): Promise<void>;
  /** Switches dark and light, and remembers it in the settings. */
  toggleTheme(): Promise<void>;
  /** A text field has focus: keys are not taken as card input meanwhile. */
  setTyping(active: boolean): void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
