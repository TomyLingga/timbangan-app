// 0005 switches on the modules of phase 4 and adds what weighing needs: the station PIN, the station of an
// exception and the record of each request the weighbridge program sent.
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/app.js";

describe("migration 0005", () => {
  it("activates the phase 4 modules and leaves the dashboard off", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ code: string; is_active: boolean }>("select code, is_active from modules order by sort_order");
    expect(rows.filter((row) => !row.is_active).map((row) => row.code)).toEqual(["dashboard"]);
    for (const code of ["weighbridge", "approvals", "security_check", "qc", "qc_approvals", "unloading", "loading", "sealing", "reports"]) {
      expect(rows.find((row) => row.code === code)?.is_active, code).toBe(true);
    }
  });

  it("adds the station PIN columns, the station of an exception and the weighbridge request log", async () => {
    const database = await freshDatabase();
    const columns = async (table: string) =>
      (await database.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1", [table])).map((row) => row.column_name);
    expect(await columns("stations")).toEqual(expect.arrayContaining(["pin_hash", "pin_failed_count", "pin_locked_until", "key_created_at"]));
    expect(await columns("exceptions")).toContain("station_id");
    expect(await columns("weighbridge_requests")).toEqual(
      expect.arrayContaining(["station_id", "request_id", "trip_id", "trip_step_id", "result", "status_code", "response", "created_at"]),
    );

    await database.query("insert into stations (site_id, code, name, kind) select id, 'WB-T', 'Timbangan uji', 'WEIGHBRIDGE' from sites");
    const station = "(select id from stations where code = 'WB-T')";
    const insert = (requestId: string, result = "SAVED") =>
      database.query(`insert into weighbridge_requests (station_id, request_id, result, status_code, response) values (${station}, $1, $2, 200, '{}')`, [requestId, result]);
    await insert("req-0001-aa");
    // one request id per station
    await expect(insert("req-0001-aa")).rejects.toThrow();
    await expect(insert("short")).rejects.toThrow();
    await expect(insert("req-0002-aa", "MAYBE")).rejects.toThrow();
    await expect(database.query(`update stations set pin_failed_count = -1 where id = ${station}`)).rejects.toThrow();
  });
});
