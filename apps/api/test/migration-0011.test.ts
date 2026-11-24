// 0011: the gps module, the tables of positions, trackers, sources and share links, and three settings.
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/app.js";

describe("migration 0011", () => {
  it("adds the active module gps, view and edit, allowed for partner accounts", async () => {
    const database = await freshDatabase();
    expect(await database.query("select name, array_to_string(levels, ',') as levels, partner_allowed, is_active from modules where code = 'gps'")).toEqual([
      { name: "Lacak kendaraan", levels: "VIEW,EDIT", partner_allowed: true, is_active: true },
    ]);
  });

  it("adds the settings with their defaults for every site", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ key: string; value: unknown }>(
      "select key, value from settings where key in ('gps_retention_days', 'gps_customer_days_after_exit', 'plant_location') and site_id is not null order by key",
    );
    expect(rows).toEqual([
      { key: "gps_customer_days_after_exit", value: 3 },
      { key: "gps_retention_days", value: 90 },
      { key: "plant_location", value: null },
    ]);
  });

  it("allows one active tracker per vehicle and one vehicle per device id of a source", async () => {
    const database = await freshDatabase();
    const [source] = await database.query<{ id: number }>("insert into gps_sources (name, kind) values ('Penyedia Contoh', 'PROVIDER') returning id::int as id");
    const [a] = await database.query<{ id: number }>("insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('ZZ1001GA', 'ZZ 1001 GA', 'TANGKI') returning id::int as id");
    const [b] = await database.query<{ id: number }>("insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('ZZ1002GA', 'ZZ 1002 GA', 'TANGKI') returning id::int as id");
    await database.query("insert into vehicle_trackers (vehicle_id, source_id, device_id) values ($1, $2, 'DEV-1')", [a?.id, source?.id]);
    await expect(database.query("insert into vehicle_trackers (vehicle_id, source_id, device_id) values ($1, $2, 'DEV-2')", [a?.id, source?.id])).rejects.toThrow();
    await expect(database.query("insert into vehicle_trackers (vehicle_id, source_id, device_id) values ($1, $2, 'DEV-1')", [b?.id, source?.id])).rejects.toThrow();
    // a detached tracker frees both
    await database.query("update vehicle_trackers set is_active = false, detached_at = now() where device_id = 'DEV-1'");
    await database.query("insert into vehicle_trackers (vehicle_id, source_id, device_id) values ($1, $2, 'DEV-1')", [b?.id, source?.id]);
    await database.query("insert into vehicle_trackers (vehicle_id, source_id, device_id) values ($1, $2, 'DEV-3')", [a?.id, source?.id]);
    expect(await database.query("select count(*)::int as n from vehicle_trackers where is_active")).toEqual([{ n: 2 }]);
  });

  it("keeps one point per vehicle and time, and a device point names its source", async () => {
    const database = await freshDatabase();
    const [v] = await database.query<{ id: number }>("insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('ZZ1003GA', 'ZZ 1003 GA', 'TANGKI') returning id::int as id");
    const insert = (at: string, kind: string, sourceId: number | null) =>
      database.query("insert into vehicle_positions (vehicle_id, at, lat, lon, source_kind, source_id) values ($1, $2::timestamptz, -10.5, 85.25, $3, $4)", [v?.id, at, kind, sourceId]);
    await insert("2026-11-20T01:00:00Z", "PHONE", null);
    await expect(insert("2026-11-20T01:00:00Z", "PHONE", null)).rejects.toThrow();
    await expect(insert("2026-11-20T01:01:00Z", "DEVICE", null)).rejects.toThrow();
  });

  it("keeps one active share link per trip; revoked ones stay", async () => {
    const database = await freshDatabase();
    const [owner] = await database.query<{ id: number }>("insert into users (kind, username, full_name, password_hash) values ('INTERNAL', 'pemilik', 'Pemilik Contoh', 'x') returning id::int as id");
    const [partner] = await database.query<{ id: number }>("insert into partners (name, is_supplier) values ('PT Contoh Lacak', true) returning id::int as id");
    const [registration] = await database.query<{ id: number }>(
      "insert into registrations (site_id, reg_no, direction, flow_code, partner_id, created_via, created_by) select id, 'REG-GPS-1', 'IN', 'IN_CPO', $1, 'OPERATOR', $2 from sites limit 1 returning id::int as id",
      [partner?.id, owner?.id],
    );
    const [trip] = await database.query<{ id: number }>("insert into trips (site_id, registration_id) select site_id, id from registrations where id = $1 returning id::int as id", [registration?.id]);
    await database.query("insert into trip_share_links (trip_id) values ($1)", [trip?.id]);
    await expect(database.query("insert into trip_share_links (trip_id) values ($1)", [trip?.id])).rejects.toThrow();
    await database.query("update trip_share_links set revoked_at = now() where trip_id = $1", [trip?.id]);
    await database.query("insert into trip_share_links (trip_id) values ($1)", [trip?.id]);
    expect(await database.query("select count(*)::int as n from trip_share_links where trip_id = $1", [trip?.id])).toEqual([{ n: 2 }]);
  });
});
