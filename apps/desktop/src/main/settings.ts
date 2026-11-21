// Settings of one weighbridge PC, kept in the Electron user-data folder: settings.json for addresses and the scale
// connection, and the station key in its own file, encrypted with the system's key store (Electron safeStorage)
// when it is available. The station PIN is not kept here; the API checks it.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScaleSettings, Settings, SettingsError } from "../shared/bridge";

export type { ScaleSettings, Settings, SettingsError };

/** Encryption of the station key; Electron's safeStorage in the program, a stand-in in tests. */
export interface SecretCodec {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: "",
  plateReaderUrl: "",
  cctvUrls: [],
  // the old program: TCP port 3002, or RS-232 at 2400 baud with 7 data bits
  scale: { driver: "simulator", host: "", port: 3002, serialPath: "COM1", baudRate: 2400, dataBits: 7, parity: "none", stopBits: 1 },
};

const URL_ERROR = "Alamat harus diawali http:// atau https://.";
const isHttp = (text: string) => /^https?:\/\/[^\s/]+/i.test(text);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const integer = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : fallback);

/** Checks and completes settings from the file or the settings screen. Empty addresses are allowed. */
export function parseSettings(raw: unknown): { settings: Settings; errors: SettingsError[] } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const scaleIn = (input.scale && typeof input.scale === "object" ? input.scale : {}) as Record<string, unknown>;
  const errors: SettingsError[] = [];
  const base = DEFAULT_SETTINGS.scale;

  const address = (field: string, value: unknown) => {
    const trimmed = text(value).replace(/\/+$/, "");
    if (trimmed && !isHttp(trimmed)) errors.push({ field, message: URL_ERROR });
    return trimmed;
  };

  const apiBaseUrl = address("apiBaseUrl", input.apiBaseUrl);
  const plateReaderUrl = address("plateReaderUrl", input.plateReaderUrl);
  const cctvList = Array.isArray(input.cctvUrls) ? input.cctvUrls.map(text).filter(Boolean) : [];
  if (cctvList.length > 2) errors.push({ field: "cctvUrls", message: "Paling banyak dua alamat gambar CCTV." });
  else if (cctvList.some((url) => !isHttp(url))) errors.push({ field: "cctvUrls", message: URL_ERROR });

  const driver = scaleIn.driver === "tcp" || scaleIn.driver === "serial" || scaleIn.driver === "simulator" ? scaleIn.driver : scaleIn.driver === undefined ? base.driver : null;
  if (driver === null) errors.push({ field: "scale.driver", message: "Jenis sambungan harus tcp, serial, atau simulator." });
  const scale: ScaleSettings = {
    driver: driver ?? base.driver,
    host: text(scaleIn.host),
    port: integer(scaleIn.port, base.port),
    serialPath: text(scaleIn.serialPath) || base.serialPath,
    baudRate: integer(scaleIn.baudRate, base.baudRate),
    dataBits: integer(scaleIn.dataBits, base.dataBits) === 8 ? 8 : 7,
    parity: scaleIn.parity === "even" || scaleIn.parity === "odd" ? scaleIn.parity : "none",
    stopBits: integer(scaleIn.stopBits, base.stopBits) === 2 ? 2 : 1,
  };
  if (scale.driver === "tcp" && !scale.host) errors.push({ field: "scale.host", message: "Alamat timbangan wajib diisi." });
  if (scale.port < 1 || scale.port > 65_535) errors.push({ field: "scale.port", message: "Port 1 sampai 65535." });
  if (scale.baudRate < 300 || scale.baudRate > 115_200) errors.push({ field: "scale.baudRate", message: "Baud rate 300 sampai 115200." });

  return { settings: { apiBaseUrl, plateReaderUrl, cctvUrls: cctvList.slice(0, 2), scale }, errors };
}

export interface LoadedSettings {
  settings: Settings;
  stationKey: string | null;
  /** True when the key on disk is encrypted by the system. */
  keyProtected: boolean;
}

export function createSettingsStore(dir: string, codec: SecretCodec) {
  const settingsFile = join(dir, "settings.json");
  const sealedKey = join(dir, "station-key.bin");
  const plainKey = join(dir, "station-key.txt");

  const readOrNull = async (file: string) => readFile(file).catch(() => null);

  return {
    async load(): Promise<LoadedSettings> {
      const raw = await readOrNull(settingsFile);
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw.toString("utf8")) : undefined;
      } catch {
        parsed = undefined;
      }
      const { settings } = parseSettings(parsed);
      const sealed = await readOrNull(sealedKey);
      if (sealed) {
        try {
          return { settings, stationKey: await codec.decrypt(sealed), keyProtected: true };
        } catch {
          return { settings, stationKey: null, keyProtected: false };
        }
      }
      const plain = await readOrNull(plainKey);
      return { settings, stationKey: plain ? plain.toString("utf8").trim() || null : null, keyProtected: false };
    },

    /** Saves settings; `stationKey` undefined keeps the stored key, null removes it. */
    async save(settings: Settings, stationKey: string | null | undefined): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      if (stationKey === undefined) return;
      await rm(sealedKey, { force: true });
      await rm(plainKey, { force: true });
      if (stationKey === null) return;
      if (await codec.available()) await writeFile(sealedKey, await codec.encrypt(stationKey));
      else await writeFile(plainKey, stationKey, { encoding: "utf8", mode: 0o600 });
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
