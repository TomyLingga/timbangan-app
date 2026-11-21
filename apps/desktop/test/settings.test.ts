import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS, parseSettings, type SecretCodec } from "../src/main/settings";

/** A reversible stand-in for safeStorage: the bytes on disk are not the key. */
const codec = (available = true): SecretCodec => ({
  available: async () => available,
  encrypt: async (text) => Buffer.from([...Buffer.from(text, "utf8")].map((byte) => byte ^ 0x5a)),
  decrypt: async (data) => Buffer.from([...data].map((byte) => byte ^ 0x5a)).toString("utf8"),
});

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("parseSettings", () => {
  it("fills defaults for a missing file: simulator scale on port 3002, 2400 baud, 7 data bits", () => {
    expect(parseSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] });
    expect(DEFAULT_SETTINGS.scale).toMatchObject({ driver: "simulator", port: 3002, baudRate: 2400, dataBits: 7, parity: "none", stopBits: 1 });
  });

  it("accepts a full TCP setup and trims addresses", () => {
    const { settings, errors } = parseSettings({
      apiBaseUrl: " https://api.example.test/ ",
      plateReaderUrl: "http://plates.example.test:5000",
      cctvUrls: ["http://cams.example.test/1.jpg", ""],
      scale: { driver: "tcp", host: "scale.example.test", port: 3002 },
    });
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ apiBaseUrl: "https://api.example.test", plateReaderUrl: "http://plates.example.test:5000", cctvUrls: ["http://cams.example.test/1.jpg"], scale: { driver: "tcp", host: "scale.example.test", port: 3002 } });
  });

  it("names each wrong field in plain Indonesian", () => {
    const { errors } = parseSettings({ apiBaseUrl: "ftp://x", scale: { driver: "tcp", host: "", port: 70_000 }, cctvUrls: ["a", "b", "c"] });
    expect(errors).toEqual([
      { field: "apiBaseUrl", message: "Alamat harus diawali http:// atau https://." },
      { field: "cctvUrls", message: "Paling banyak dua alamat gambar CCTV." },
      { field: "scale.host", message: "Alamat timbangan wajib diisi." },
      { field: "scale.port", message: "Port 1 sampai 65535." },
    ]);
  });
});

describe("settings store", () => {
  it("keeps settings in the folder and the station key encrypted beside them", async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-settings-"));
    const store = createSettingsStore(dir, codec());
    expect(await store.load()).toEqual({ settings: DEFAULT_SETTINGS, stationKey: null, keyProtected: false });
    await store.save({ ...DEFAULT_SETTINGS, apiBaseUrl: "https://api.example.test" }, "st3.secret-value");
    expect(await store.load()).toEqual({ settings: { ...DEFAULT_SETTINGS, apiBaseUrl: "https://api.example.test" }, stationKey: "st3.secret-value", keyProtected: true });
    for (const file of await readdir(dir)) expect(await readFile(join(dir, file), "utf8")).not.toContain("secret-value");
  });

  it("keeps the key when settings are saved without a new one, and removes it on request", async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-settings-"));
    const store = createSettingsStore(dir, codec());
    await store.save(DEFAULT_SETTINGS, "st3.secret-value");
    await store.save({ ...DEFAULT_SETTINGS, plateReaderUrl: "http://plates.example.test" }, undefined);
    expect((await store.load()).stationKey).toBe("st3.secret-value");
    await store.save(DEFAULT_SETTINGS, null);
    expect((await store.load()).stationKey).toBeNull();
  });

  it("falls back to a plain key file when the system cannot encrypt, and says so", async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-settings-"));
    const store = createSettingsStore(dir, codec(false));
    await store.save(DEFAULT_SETTINGS, "st3.secret-value");
    expect(await store.load()).toMatchObject({ stationKey: "st3.secret-value", keyProtected: false });
  });
});
