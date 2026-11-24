// GET and PUT /api/gps/settings: where the plant is, how long points are kept, and how long a customer still follows a
// truck after it left the plant. Staff with gps EDIT only; every change is written to the audit log.
import { describe, expect, it } from "vitest";
import { gpsSettings } from "../src/gps/trips.js";
import { gpsApp, SEA } from "./helpers/gps.js";

const DEFAULTS = { plantLocation: null, retentionDays: 90, customerDaysAfterExit: 3 };

describe("GET /api/gps/settings", () => {
  it("answers the defaults of migration 0011", async () => {
    const { call } = await gpsApp();
    const response = await call("GET", "/api/gps/settings", "lacak");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ settings: DEFAULTS });
  });

  it("needs gps EDIT and a staff account", async () => {
    const { call } = await gpsApp();
    for (const user of ["lihat", "logistik", "angkut1", "pks1"]) {
      expect((await call("GET", "/api/gps/settings", user)).statusCode, user).toBe(403);
      expect((await call("PUT", "/api/gps/settings", user, { retentionDays: 30 })).statusCode, user).toBe(403);
    }
    expect((await call("GET", "/api/gps/settings", null)).statusCode).toBe(401);
  });
});

describe("PUT /api/gps/settings", () => {
  it("stores what is sent, keeps the rest, and the GPS routes use it", async () => {
    const { call, database } = await gpsApp();
    const response = await call("PUT", "/api/gps/settings", "lacak", { plantLocation: SEA, retentionDays: 30, customerDaysAfterExit: 0 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ settings: { plantLocation: SEA, retentionDays: 30, customerDaysAfterExit: 0 } });
    expect(await gpsSettings(database.db)).toEqual({ plant: SEA, retentionDays: 30, customerDays: 0 });

    const partial = await call("PUT", "/api/gps/settings", "lacak", { retentionDays: 730 });
    expect(partial.json()).toEqual({ settings: { plantLocation: SEA, retentionDays: 730, customerDaysAfterExit: 0 } });
    expect((await call("GET", "/api/gps/settings", "lacak")).json()).toEqual({ settings: { plantLocation: SEA, retentionDays: 730, customerDaysAfterExit: 0 } });

    const cleared = await call("PUT", "/api/gps/settings", "lacak", { plantLocation: null, customerDaysAfterExit: 30 });
    expect(cleared.json()).toEqual({ settings: { plantLocation: null, retentionDays: 730, customerDaysAfterExit: 30 } });
    expect((await gpsSettings(database.db)).plant).toBeNull();
    const [row] = await database.query<{ value: unknown }>("select value from settings where key = 'plant_location' and site_id is not null");
    expect(row?.value).toBeNull();
  });

  it("writes one audit row per change with the settings before and after", async () => {
    const { call, database } = await gpsApp();
    await call("PUT", "/api/gps/settings", "lacak", { retentionDays: 45 });
    const rows = await database.query<{ action: string; entity_type: string; before: unknown; after: unknown }>(
      "select action, entity_type, before, after from audit_log where entity_type = 'settings' order by id",
    );
    expect(rows).toEqual([{ action: "GPS_SETTINGS_CHANGED", entity_type: "settings", before: DEFAULTS, after: { ...DEFAULTS, retentionDays: 45 } }]);
  });

  it("refuses values out of range, and a body without any setting, and stores nothing", async () => {
    const { call, database } = await gpsApp();
    const refused = async (body: unknown) => {
      const response = await call("PUT", "/api/gps/settings", "lacak", body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      return (response.json().error.fields as { field: string }[]).map((field) => field.field).sort();
    };
    expect(await refused({ retentionDays: 6 })).toEqual(["retentionDays"]);
    expect(await refused({ retentionDays: 731 })).toEqual(["retentionDays"]);
    expect(await refused({ retentionDays: 30.5 })).toEqual(["retentionDays"]);
    expect(await refused({ customerDaysAfterExit: -1 })).toEqual(["customerDaysAfterExit"]);
    expect(await refused({ customerDaysAfterExit: 31 })).toEqual(["customerDaysAfterExit"]);
    expect(await refused({ plantLocation: { lat: 91, lon: 0 } })).toEqual(["plantLocation.lat"]);
    expect(await refused({ plantLocation: { lat: 0, lon: -181 } })).toEqual(["plantLocation.lon"]);
    expect(await refused({ plantLocation: { lat: "x", lon: 1 } })).toEqual(["plantLocation.lat"]);
    expect((await call("PUT", "/api/gps/settings", "lacak", {})).statusCode).toBe(400);
    expect((await call("GET", "/api/gps/settings", "lacak")).json()).toEqual({ settings: DEFAULTS });
    expect(await database.query("select count(*)::int as n from audit_log where entity_type = 'settings'")).toEqual([{ n: 0 }]);
  });
});
