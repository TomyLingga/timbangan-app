import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("GET /api/health", () => {
  it("answers without authentication while the database is up", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ok", database: "up", version });
  });

  it("reports the database as down when it cannot be queried", async () => {
    const { app, database } = await testApp();
    await database.close();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", database: "down", version });
  });
});

describe("application shell", () => {
  it("sends security headers", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBeDefined();
  });

  it("allows the web origin with credentials and no other origin", async () => {
    const { app } = await testApp({ WEB_ORIGIN: "http://web.test:3000" });
    const allowed = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://web.test:3000" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://web.test:3000");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const other = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://evil.test" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/login",
      headers: { origin: "http://web.test:3000", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://web.test:3000");
  });

  it("answers an unknown route with the JSON error envelope", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } });
  });

  it("redacts authorization, cookie, password and token in log lines", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { app } = await testApp({}, { logger: { level: "info", stream } });
    app.log.info(
      { req: { headers: { authorization: "Bearer aaa.bbb.ccc", cookie: "refresh_token=zzz" } }, body: { password: "hunter2", token: "sso-ticket" }, password: "p4ss", token: "t0k" },
      "probe",
    );
    const output = lines.join("");
    expect(output).toContain("probe");
    for (const secret of ["aaa.bbb.ccc", "refresh_token=zzz", "hunter2", "sso-ticket", "p4ss", "t0k"]) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });
});
