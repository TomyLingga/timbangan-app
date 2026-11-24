/// <reference types="node" />
// app.config.js: the build with and without the Firebase file. Uses a dummy file, never the real one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const appConfig = require("../../app.config.js") as (input: { config: Record<string, unknown> }) => {
  android: Record<string, unknown>;
  extra: Record<string, unknown>;
};
const base = { name: "Timbangan Lapangan", android: { package: "app.timbangan.lapangan", versionCode: 3 }, extra: { other: 1 } };

describe("app.config.js", () => {
  const saved = process.env.GOOGLE_SERVICES_JSON;
  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_SERVICES_JSON;
    else process.env.GOOGLE_SERVICES_JSON = saved;
  });

  it("without the file: no googleServicesFile, pushes switched off, the rest kept", () => {
    process.env.GOOGLE_SERVICES_JSON = "";
    const config = appConfig({ config: base });
    // ./google-services.json is git-ignored and absent on a clean checkout; a local copy switches pushes on
    expect(config.extra.pushEnabled).toBe(config.android.googleServicesFile === "./google-services.json");
    expect(config.android.package).toBe("app.timbangan.lapangan");
    expect(config.android.versionCode).toBe(3);
    expect(config.extra.other).toBe(1);
  });

  it("with GOOGLE_SERVICES_JSON: the file is given to the build and pushes are on", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gsj-"));
    const file = path.join(dir, "google-services.json");
    writeFileSync(file, "{}");
    try {
      process.env.GOOGLE_SERVICES_JSON = file;
      const config = appConfig({ config: base });
      expect(config.android.googleServicesFile).toBe(file);
      expect(config.extra.pushEnabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a wrong GOOGLE_SERVICES_JSON stops the build instead of building without pushes", () => {
    process.env.GOOGLE_SERVICES_JSON = path.join(tmpdir(), "does-not-exist", "google-services.json");
    expect(() => appConfig({ config: base })).toThrow(/does not exist/);
  });
});
