// The machine credential of a station (X-Station-Key) and the station PIN that opens manual plate entry.
import { describe, expect, it } from "vitest";
import { generateStationKey, keyMatches, stationIdOfKey } from "../src/stations/keys.js";
import { checkStationPin, PIN_LOCK_MS, PIN_MAX_FAILURES, setStationPin } from "../src/stations/pin.js";
import { createStationGuard } from "../src/stations/guard.js";
import { testApp } from "./helpers/app.js";

async function seedStation(database: { query: (text: string, params?: unknown[]) => Promise<unknown[]> }, code: string, kind = "WEIGHBRIDGE", active = true): Promise<number> {
  const rows = (await database.query("insert into stations (site_id, code, name, kind, is_active) select id, $1, $2, $3, $4 from sites returning id", [code, `Stasiun ${code}`, kind, active])) as { id: number }[];
  return Number(rows[0]?.id);
}

describe("station key", () => {
  it("names its station, is stored only as a hash, and matches only itself", () => {
    const { key, hash } = generateStationKey(12);
    expect(key).toMatch(/^st12\.[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key.slice(5));
    expect(stationIdOfKey(key)).toBe(12);
    expect(keyMatches(hash, key)).toBe(true);
    expect(keyMatches(hash, `${key}x`)).toBe(false);
    expect(keyMatches(hash, generateStationKey(12).key)).toBe(false);
    expect(keyMatches(null, key)).toBe(false);
    for (const bad of ["", "st.abc", "stx.abc", "12.abc", "st0.abc", "st12"]) expect(stationIdOfKey(bad), bad).toBeNull();
  });

  it("lets a request with the active station's key through and refuses everything else with 401", async () => {
    const { app, database } = await testApp();
    const wb = await seedStation(database, "WB-1");
    const off = await seedStation(database, "WB-2", "WEIGHBRIDGE", false);
    const desk = await seedStation(database, "REG-1", "REGISTRATION");
    const keys = new Map<number, string>();
    for (const id of [wb, off, desk]) {
      const { key, hash } = generateStationKey(id);
      keys.set(id, key);
      await database.query("update stations set api_key_hash = $1 where id = $2", [hash, id]);
    }
    const guard = createStationGuard(database.db);
    app.get("/test/station", { preHandler: guard }, async (request) => ({ station: request.station }));

    const ok = await app.inject({ method: "GET", url: "/test/station", headers: { "x-station-key": keys.get(wb) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().station).toMatchObject({ id: wb, code: "WB-1", kind: "WEIGHBRIDGE" });

    const refusals = [
      {},
      { "x-station-key": "st999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { "x-station-key": keys.get(off) },
      { "x-station-key": keys.get(desk) },
      // the key of one station sent with another station's number
      { "x-station-key": `st${desk}.${keys.get(wb)?.split(".")[1]}` },
      { authorization: "Bearer something" },
    ];
    for (const headers of refusals) {
      const response = await app.inject({ method: "GET", url: "/test/station", headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
      expect(response.json().error.code).toBe("STATION_UNAUTHENTICATED");
    }
  });
});

describe("station PIN", () => {
  it("is stored as a hash, counts wrong attempts, locks after the limit and resets on success", async () => {
    const { database, clock } = await testApp();
    const id = await seedStation(database, "WB-1");
    expect(await checkStationPin(database.db, id, "1234", clock.now())).toEqual({ ok: false, code: "PIN_NOT_SET" });

    await setStationPin(database.db, id, "482915");
    const [row] = await database.query<{ pin_hash: string }>("select pin_hash from stations where id = $1", [id]);
    expect(row?.pin_hash).toMatch(/^\$argon2id\$/);

    expect(await checkStationPin(database.db, id, "000000", clock.now())).toEqual({ ok: false, code: "PIN_WRONG", attemptsLeft: PIN_MAX_FAILURES - 1 });
    expect(await checkStationPin(database.db, id, "482915", clock.now())).toEqual({ ok: true });
    // success resets the count
    for (let n = 1; n < PIN_MAX_FAILURES; n++) {
      expect(await checkStationPin(database.db, id, "000000", clock.now())).toEqual({ ok: false, code: "PIN_WRONG", attemptsLeft: PIN_MAX_FAILURES - n });
    }
    const locked = await checkStationPin(database.db, id, "000000", clock.now());
    expect(locked).toEqual({ ok: false, code: "PIN_LOCKED", until: new Date(clock.now().getTime() + PIN_LOCK_MS) });
    // while locked even the right PIN is refused
    expect((await checkStationPin(database.db, id, "482915", clock.now())).ok).toBe(false);
    clock.advance(PIN_LOCK_MS + 1);
    expect(await checkStationPin(database.db, id, "482915", clock.now())).toEqual({ ok: true });
    expect(await database.query("select pin_failed_count, pin_locked_until from stations where id = $1", [id])).toEqual([{ pin_failed_count: 0, pin_locked_until: null }]);
  });
});
