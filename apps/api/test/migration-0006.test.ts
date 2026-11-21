// 0006 adds what the field forms of phase 5 need: the plant master module, the quality parameters of QC
// loading, document numbers on quality checks and trips, the submission log of the phone forms, and seal links.
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/app.js";

const columns = async (database: Awaited<ReturnType<typeof freshDatabase>>, table: string) =>
  (await database.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1", [table])).map((row) => row.column_name);

describe("migration 0006", () => {
  it("adds the active module plant_masters for staff only", async () => {
    const database = await freshDatabase();
    expect(await database.query("select name, array_to_string(levels, ',') as levels, partner_allowed, is_active from modules where code = 'plant_masters'")).toEqual([
      { name: "Master pabrik", levels: "VIEW,CREATE,EDIT", partner_allowed: false, is_active: true },
    ]);
  });

  it("adds the quality parameters of QC loading after FFA, moisture and impurities", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ code: string; unit: string; min_valid: string; max_valid: string }>(
      "select code, unit, min_valid::text as min_valid, max_valid::text as max_valid from quality_parameters order by sort_order",
    );
    expect(rows.map((row) => row.code)).toEqual(["FFA", "MOISTURE", "IMPURITIES", "MNI", "IV", "LOVIBOND", "MELTING_POINT", "CLOUD_POINT", "SAPONIFIABLE", "PEROXIDE", "SMOKE_POINT"]);
    const unit = (code: string) => rows.find((row) => row.code === code)?.unit;
    expect([unit("MNI"), unit("MELTING_POINT"), unit("SAPONIFIABLE"), unit("PEROXIDE"), unit("SMOKE_POINT")]).toEqual(["%", "°C", "%", "meq/kg", "°C"]);
    for (const row of rows) expect(Number(row.max_valid), row.code).toBeGreaterThan(Number(row.min_valid));
    const active = await database.query<{ code: string }>("select code from quality_parameters where is_active order by sort_order");
    expect(active.map((row) => row.code)).toEqual(["FFA", "MOISTURE", "IMPURITIES"]);
  });

  it("adds the number formats of the certificate, the delivery note and the out-spec letter", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ key: string; value: string }>("select key, value #>> '{}' as value from settings where key like '%number_format' order by key");
    expect(rows).toEqual([
      { key: "coa_number_format", value: "{seq:4}/COA/{site}/{roman}/{yyyy}" },
      { key: "delivery_note_number_format", value: "{seq:4}/SJ/{site}/{roman}/{yyyy}" },
      { key: "do_number_format", value: "{seq:3}/DO/{site}/{roman}/{yyyy}" },
      { key: "out_spec_letter_number_format", value: "{seq:4}/OS/{site}/{roman}/{yyyy}" },
    ]);
  });

  it("adds the columns the forms write", async () => {
    const database = await freshDatabase();
    expect(await columns(database, "quality_checks")).toEqual(expect.arrayContaining(["reason_code", "certificate_no", "disposition"]));
    expect(await columns(database, "trips")).toEqual(expect.arrayContaining(["delivery_note_no", "out_spec_letter_no"]));
    expect(await columns(database, "trip_seals")).toEqual(expect.arrayContaining(["trip_step_id", "removed_by"]));
    expect(await columns(database, "field_submissions")).toEqual(expect.arrayContaining(["client_uuid", "trip_step_id", "form", "user_id", "response", "created_at"]));
  });

  it("keeps the rules of quality checks, numbers, seals and submissions in the database", async () => {
    const database = await freshDatabase();
    const [site] = await database.query<{ id: number }>("select id from sites limit 1");
    const [user] = await database.query<{ id: number }>("insert into users (kind, username, full_name, password_hash) values ('INTERNAL', 'uji', 'Uji', 'x') returning id");
    const [partner] = await database.query<{ id: number }>("insert into partners (name) values ('PT Contoh') returning id");
    const [registration] = await database.query<{ id: number }>(
      "insert into registrations (site_id, reg_no, direction, flow_code, partner_id, created_via, created_by) values ($1, 'REG-1', 'IN', 'IN_CPO', $2, 'OPERATOR', $3) returning id",
      [site?.id, partner?.id, user?.id],
    );
    const trip = async (seq: number) =>
      Number((await database.query<{ id: number }>("insert into trips (site_id, registration_id, seq) values ($1, $2, $3) returning id", [site?.id, registration?.id, seq]))[0]?.id);
    const tripId = await trip(1);
    const other = await trip(2);
    const check = (fields: string, values: string) => database.query(`insert into quality_checks (trip_id, stage, ${fields}) values (${tripId}, ${values})`);

    // the reason comes with a disposition other than OK, and only at receiving
    await check("disposition, reason_code", "'RECEIVING', 'HOLD', 'FFA_OUT'");
    await check("disposition", "'RECEIVING', 'OK'");
    await expect(check("disposition", "'RECEIVING', 'NOT_OK'")).rejects.toThrow();
    await expect(check("disposition, reason_code", "'RECEIVING', 'OK', 'MI_OUT'")).rejects.toThrow();
    await expect(check("disposition, reason_code", "'RECEIVING', 'HOLD', 'OTHER'")).rejects.toThrow();
    await expect(check("disposition", "'LOADING', 'OK'")).rejects.toThrow();
    // a certificate number only on a loading check, once
    await check("certificate_no", "'LOADING', 'C-1'");
    await expect(check("certificate_no", "'LOADING', 'C-1'")).rejects.toThrow();
    await expect(check("certificate_no", "'RECEIVING', 'C-2'")).rejects.toThrow();
    // a pass or a rejection names who decided
    await expect(check("decision", "'RECEIVING', 'PASS'")).rejects.toThrow();
    await check("decision", "'RECEIVING', 'HOLD'");

    await database.query("update trips set delivery_note_no = 'SJ-1', out_spec_letter_no = 'OS-1' where id = $1", [tripId]);
    await expect(database.query("update trips set delivery_note_no = 'SJ-1' where id = $1", [other])).rejects.toThrow();
    await expect(database.query("update trips set out_spec_letter_no = 'OS-1' where id = $1", [other])).rejects.toThrow();

    // a stock seal goes on one truck only, and a removed seal carries its reason
    const [seal] = await database.query<{ id: number }>("insert into seals (site_id, seal_no) values ($1, 'S-1') returning id", [site?.id]);
    await database.query("insert into trip_seals (trip_id, seal_no, origin, seal_id) values ($1, 'S-1', 'APPLIED', $2)", [tripId, seal?.id]);
    await expect(database.query("insert into trip_seals (trip_id, seal_no, origin, seal_id) values ($1, 'S-1', 'APPLIED', $2)", [other, seal?.id])).rejects.toThrow();
    await expect(database.query("update trip_seals set removed_at = now() where trip_id = $1", [tripId])).rejects.toThrow();
    await database.query("update trip_seals set removed_at = now(), remove_reason = 'Tambah muatan' where trip_id = $1", [tripId]);

    const [step] = await database.query<{ id: number }>("insert into trip_steps (trip_id, step_code, seq) values ($1, 'QC', 4) returning id", [tripId]);
    const submit = (uuid: string, form: string) =>
      database.query("insert into field_submissions (client_uuid, trip_step_id, form, user_id, response) values ($1, $2, $3, $4, '{}')", [uuid, step?.id, form, user?.id]);
    await submit("6f1c0c3e-0000-4000-8000-000000000001", "QC_RECEIVING");
    await expect(submit("6f1c0c3e-0000-4000-8000-000000000001", "QC_RECEIVING")).rejects.toThrow();
    await expect(submit("6f1c0c3e-0000-4000-8000-000000000002", "SOMETHING")).rejects.toThrow();
  });
});
