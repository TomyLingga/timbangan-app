// Stations: the weighbridge PCs and other fixed points, their machine key and PIN.
import { describe, expect, it } from "vitest";
import { keyMatches } from "../src/stations/keys.js";
import { testApp } from "./helpers/app.js";
import { bearer, seedStaff } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  await seedStaff(context.database, "admin", { weighbridge: "EDIT" });
  const headers = await bearer(context.app, "admin");
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => context.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { ...context, call };
}

const WB_IN = { code: "WB-IN", name: "Timbangan masuk", kind: "WEIGHBRIDGE", config: { directions: ["IN"], cameraWeigh1: 3, cameraWeigh2: 4, plateAttempts: 2 } };

describe("stations", () => {
  it("creates, lists and changes a weighbridge with its config, and fills the config defaults", async () => {
    const { call, database } = await setup();
    const created = await call("POST", "/api/stations", { ...WB_IN, pin: "482915" });
    expect(created.statusCode).toBe(201);
    const station = created.json().station;
    expect(station).toEqual({
      id: expect.any(Number), code: "WB-IN", name: "Timbangan masuk", kind: "WEIGHBRIDGE", zoneId: null,
      config: { directions: ["IN"], cameraWeigh1: 3, cameraWeigh2: 4, plateAttempts: 2 }, isActive: true, hasKey: false, keyCreatedAt: null, hasPin: true,
    });
    const other = (await call("POST", "/api/stations", { code: "WB-OUT", name: "Timbangan keluar", kind: "WEIGHBRIDGE", config: { directions: ["OUT"] } })).json().station;
    expect(other.config).toEqual({ directions: ["OUT"], cameraWeigh1: null, cameraWeigh2: null, plateAttempts: 3 });
    expect(other.hasPin).toBe(false);

    expect((await call("GET", "/api/stations")).json().items.map((item: { code: string }) => item.code)).toEqual(["WB-IN", "WB-OUT"]);
    const patched = await call("PATCH", `/api/stations/${other.id}`, { name: "Timbangan dua", config: { directions: ["IN", "OUT"], plateAttempts: 1 }, pin: "1234" });
    expect(patched.json().station).toMatchObject({ name: "Timbangan dua", config: { directions: ["IN", "OUT"], plateAttempts: 1 }, hasPin: true });
    expect((await call("PATCH", `/api/stations/${other.id}`, { pin: null, isActive: false })).json().station).toMatchObject({ hasPin: false, isActive: false });
    // the PIN never reaches the audit log
    const audit = await database.query<{ action: string; after: unknown }>("select action, after from audit_log where entity_type = 'station' order by id");
    expect(audit.map((row) => row.action)).toEqual(["STATION_CREATED", "STATION_CREATED", "STATION_UPDATED", "STATION_UPDATED"]);
    expect(JSON.stringify(audit)).not.toContain("482915");
    expect(JSON.stringify(audit)).not.toContain("1234");
  });

  it("refuses a duplicate code, a bad weighbridge config, a short PIN and an unknown station", async () => {
    const { call } = await setup();
    await call("POST", "/api/stations", WB_IN);
    expect((await call("POST", "/api/stations", WB_IN)).json().error.code).toBe("DUPLICATE");
    const bad = await call("POST", "/api/stations", { code: "WB-X", name: "X", kind: "WEIGHBRIDGE", config: { directions: [], plateAttempts: 0 }, pin: "12" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((field: { field: string }) => field.field).sort()).toEqual(["config.directions", "config.plateAttempts", "pin"]);
    expect((await call("POST", "/api/stations", { code: "Q", name: "Q", kind: "NOPE" })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/stations/999999", { name: "x" })).statusCode).toBe(404);
    expect((await call("POST", "/api/stations/999999/key")).statusCode).toBe(404);
  });

  it("makes a machine key, shows it once, stores only its hash and replaces it on the next call", async () => {
    const { call, database } = await setup();
    const station = (await call("POST", "/api/stations", WB_IN)).json().station;
    const first = await call("POST", `/api/stations/${station.id}/key`);
    expect(first.statusCode).toBe(200);
    const { key } = first.json();
    expect(key).toMatch(new RegExp(`^st${station.id}\\.`));
    expect(first.json().station).toMatchObject({ hasKey: true, keyCreatedAt: "2026-11-20T03:00:00.000Z" });
    const [row] = await database.query<{ api_key_hash: string }>("select api_key_hash from stations where id = $1", [station.id]);
    expect(row?.api_key_hash).not.toContain(key.split(".")[1]);
    expect(JSON.stringify((await call("GET", "/api/stations")).json())).not.toContain(key);
    expect(JSON.stringify(await database.query("select * from audit_log"))).not.toContain(key.split(".")[1]);

    const storedHash = async () => (await database.query<{ api_key_hash: string }>("select api_key_hash from stations where id = $1", [station.id]))[0]?.api_key_hash ?? null;
    expect(keyMatches(await storedHash(), key)).toBe(true);
    const second = (await call("POST", `/api/stations/${station.id}/key`)).json().key;
    expect(keyMatches(await storedHash(), key)).toBe(false);
    expect(keyMatches(await storedHash(), second)).toBe(true);
  });
});
