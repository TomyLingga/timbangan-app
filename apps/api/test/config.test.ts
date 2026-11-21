import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "pglite://memory",
  JWT_SECRET: "x".repeat(32),
};

describe("loadConfig", () => {
  it("fills the defaults when only the required keys are given", () => {
    const config = loadConfig(base);
    expect(config).toEqual({
      port: 3100,
      host: "127.0.0.1",
      databaseUrl: "pglite://memory",
      jwtSecret: "x".repeat(32),
      webOrigin: "http://localhost:3000",
      accessTokenTtlS: 900,
      refreshTokenTtlDays: 30,
      odoo: null,
      portal: null,
      vcf: null,
      bootstrapAdminEmails: [],
      tts: { engine: "off", cacheDir: ".data/tts-cache" },
      files: { dir: ".data/files" },
    });
  });

  it("reads numbers from text and treats an empty value as absent", () => {
    const config = loadConfig({ ...base, PORT: "4000", HOST: "", ACCESS_TOKEN_TTL_S: "60", REFRESH_TOKEN_TTL_DAYS: "" });
    expect(config.port).toBe(4000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.accessTokenTtlS).toBe(60);
    expect(config.refreshTokenTtlDays).toBe(30);
  });

  it("names every invalid key in one readable message", () => {
    expect(() => loadConfig({ JWT_SECRET: "short", PORT: "abc" })).toThrow(ConfigError);
    let message = "";
    try {
      loadConfig({ JWT_SECRET: "short", PORT: "abc" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("JWT_SECRET");
    expect(message).toContain("at least 32 characters");
    expect(message).toContain("PORT");
    // the value of a secret never appears in the message
    expect(message).not.toContain("short");
  });

  it("refuses a database URL with an unknown scheme", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: "mysql://localhost/x" })).toThrow(/DATABASE_URL/);
  });

  it("gives the Odoo group only when all four keys are set", () => {
    const odoo = { ODOO_URL: "http://127.0.0.1:8069/", ODOO_DB: "db", ODOO_UID: "7", ODOO_PASSWORD: "secret" };
    expect(loadConfig({ ...base, ...odoo }).odoo).toEqual({ url: "http://127.0.0.1:8069", db: "db", uid: 7, password: "secret" });
    expect(loadConfig({ ...base, ...odoo, ODOO_PASSWORD: "" }).odoo).toBeNull();
    expect(loadConfig({ ...base, ODOO_URL: odoo.ODOO_URL }).odoo).toBeNull();
  });

  it("gives the portal group only when all three keys are set", () => {
    const portal = { PORTAL_API_URL: "http://127.0.0.1:9000/api/", PORTAL_WEB_URL: "http://127.0.0.1:9001", PORTAL_APP_NAME: "Timbangan Registrasi" };
    expect(loadConfig({ ...base, ...portal }).portal).toEqual({
      apiUrl: "http://127.0.0.1:9000/api",
      webUrl: "http://127.0.0.1:9001",
      appName: "Timbangan Registrasi",
    });
    expect(loadConfig({ ...base, ...portal, PORTAL_APP_NAME: undefined }).portal).toBeNull();
  });

  it("reads the bootstrap admin emails as a lower-case list, comma separated", () => {
    expect(loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAILS: " Admin.Satu@Example.test, ,admin.dua@example.test " }).bootstrapAdminEmails).toEqual([
      "admin.satu@example.test",
      "admin.dua@example.test",
    ]);
    expect(loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAILS: "" }).bootstrapAdminEmails).toEqual([]);
  });
});
