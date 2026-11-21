// The narrow, typed bridge between the window and the main process. The window only displays and plays audio;
// everything else (devices, network, settings, log) stays in the main process.
import type { ScreenState } from "./screen";

export type ScaleStatus = "connecting" | "connected" | "disconnected" | "unavailable";

export interface StationLinks {
  scale: ScaleStatus;
  scaleDetail: string | null;
  /** ok: the API answered the last call; down: it did not. */
  api: "unknown" | "ok" | "down";
  /** The plate reader's camera status (online, lagging, offline), "down" without an answer, "off" when not set. */
  plate: string;
}

export interface StationView {
  screen: ScreenState;
  links: StationLinks;
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

export interface Settings {
  apiBaseUrl: string;
  plateReaderUrl: string;
  /** Up to two JPEG snapshot addresses shown beside the weight. */
  cctvUrls: string[];
  scale: ScaleSettings;
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
  index: number;
  jpeg: Uint8Array | null;
}

export interface DesktopBridge {
  onView(listener: (view: StationView) => void): () => void;
  onSpeak(listener: (segments: string[]) => void): () => void;
  onCctv(listener: (frame: CctvFrame) => void): () => void;
  /** Asks the main process for the current view (on load). */
  ready(): Promise<StationView>;
  /** The WAV of one segment from the API; null when there is none. */
  speechAudio(text: string): Promise<ArrayBuffer | null>;
  /** Whether settings open without the PIN (first setup: no station key yet). */
  settingsNeedPin(): Promise<boolean>;
  /** Checks the station PIN with the API (POST /api/weighbridge/manual-plate). */
  unlock(pin: string, purpose: UnlockPurpose): Promise<UnlockResult>;
  getSettings(): Promise<SettingsForm | null>;
  saveSettings(input: SettingsInput): Promise<SaveResult>;
  setManualPlate(plate: string | null): Promise<boolean>;
  /** A text field has focus: keys are not taken as card input meanwhile. */
  setTyping(active: boolean): void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
