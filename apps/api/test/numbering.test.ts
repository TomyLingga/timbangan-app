import { describe, expect, it } from "vitest";
import {
  doNumber,
  nextDocumentNo,
  plantDateParts,
  registrationNo,
  romanMonth,
  spjNumber,
  takeNumber,
  tripNumber,
} from "../src/numbering.js";
import { readSetting } from "../src/settings.js";
import { freshDatabase } from "./helpers/app.js";

describe("migration 0003", () => {
  it("adds registrations.check_findings, an empty list by default", async () => {
    const database = await freshDatabase();
    const [column] = await database.query<{ data_type: string; is_nullable: string; column_default: string }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'registrations' and column_name = 'check_findings'",
    );
    expect(column).toEqual({ data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" });
  });

  it("gives every site the default DO number format", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ site_id: number; value: unknown }>("select site_id, value from settings where key = 'do_number_format'");
    const sites = await database.query<{ id: number }>("select id from sites");
    expect(rows.map((row) => Number(row.site_id)).sort()).toEqual(sites.map((site) => Number(site.id)).sort());
    expect(rows[0]?.value).toBe("{seq:3}/DO/{site}/{roman}/{yyyy}");
    expect(await readSetting(database.db, Number(sites[0]?.id), "do_number_format")).toBe("{seq:3}/DO/{site}/{roman}/{yyyy}");
  });
});

describe("readSetting", () => {
  it("prefers the site's row over the global one and answers undefined when neither exists", async () => {
    const database = await freshDatabase();
    const [site] = await database.query<{ id: number }>("select id from sites");
    await database.query("insert into settings (site_id, key, value) values (null, 'probe', '1'), ($1, 'probe', '2')", [site?.id]);
    await database.query("insert into settings (site_id, key, value) values (null, 'only_global', '\"x\"')");
    expect(await readSetting(database.db, Number(site?.id), "probe")).toBe(2);
    expect(await readSetting(database.db, Number(site?.id), "only_global")).toBe("x");
    expect(await readSetting(database.db, Number(site?.id), "missing")).toBeUndefined();
  });
});

describe("takeNumber", () => {
  it("starts a series at 1 and counts up per key", async () => {
    const database = await freshDatabase();
    expect(await takeNumber(database.db, "A/1")).toBe(1);
    expect(await takeNumber(database.db, "A/1")).toBe(2);
    expect(await takeNumber(database.db, "B/1")).toBe(1);
    expect(await database.query("select counter_key, last_no from document_counters order by counter_key")).toEqual([
      { counter_key: "A/1", last_no: 2 },
      { counter_key: "B/1", last_no: 1 },
    ]);
  });

  it("gives two different numbers to two transactions that take one at the same time", async () => {
    const database = await freshDatabase();
    const take = () => database.db.transaction(async (tx) => takeNumber(tx, "SER/1"));
    const numbers = await Promise.all([take(), take(), take(), take()]);
    expect([...numbers].sort()).toEqual([1, 2, 3, 4]);
  });

  it("leaves no gap when the transaction that took a number rolls back", async () => {
    const database = await freshDatabase();
    await expect(
      database.db.transaction(async (tx) => {
        await takeNumber(tx, "SER/2");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await takeNumber(database.db, "SER/2")).toBe(1);
  });
});

describe("document numbers", () => {
  // 2026-11-30 20:00 UTC is already 1 December in Jakarta
  const lateNovemberUtc = new Date("2026-11-30T20:00:00Z");

  it("reads the date parts in the plant's time zone", () => {
    expect(plantDateParts(lateNovemberUtc)).toEqual({ yyyy: "2026", mm: "12", dd: "01" });
    expect(plantDateParts(new Date("2026-11-20T03:00:00Z"))).toEqual({ yyyy: "2026", mm: "11", dd: "20" });
  });

  it("writes months as roman numerals", () => {
    expect(Array.from({ length: 12 }, (_, index) => romanMonth(index + 1))).toEqual(["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]);
  });

  it("formats SPJ, registration and trip numbers", () => {
    const at = new Date("2026-11-20T03:00:00Z");
    expect(spjNumber("XYZ", at, 7)).toBe("SPJ/XYZ/202611/00007");
    expect(registrationNo("XYZ", at, 123456)).toBe("REG/XYZ/202611/123456");
    expect(tripNumber(at, 12)).toBe("20261120-0012");
    expect(tripNumber(lateNovemberUtc, 1)).toBe("20261201-0001");
  });

  it("formats a DO number from the setting's pattern", () => {
    const at = new Date("2026-11-20T03:00:00Z");
    expect(doNumber("{seq:3}/DO/{site}/{roman}/{yyyy}", { seq: 7, site: "XYZ", at })).toBe("007/DO/XYZ/XI/2026");
    expect(doNumber("DO-{yy}{mm}-{seq}", { seq: 42, site: "XYZ", at })).toBe("DO-2611-42");
    expect(doNumber("{seq:2}", { seq: 1234, site: "XYZ", at })).toBe("1234");
  });

  it("takes the next number of the right series", async () => {
    const database = await freshDatabase();
    const at = new Date("2026-11-20T03:00:00Z");
    expect(await nextDocumentNo(database.db, "SPJ", "XYZ", at)).toBe("SPJ/XYZ/202611/00001");
    expect(await nextDocumentNo(database.db, "SPJ", "XYZ", at)).toBe("SPJ/XYZ/202611/00002");
    // a new month starts again at 1
    expect(await nextDocumentNo(database.db, "SPJ", "XYZ", lateNovemberUtc)).toBe("SPJ/XYZ/202612/00001");
    expect(await nextDocumentNo(database.db, "REG", "XYZ", at)).toBe("REG/XYZ/202611/00001");
    expect(await nextDocumentNo(database.db, "TRIP", "XYZ", at)).toBe("20261120-0001");
    expect(await nextDocumentNo(database.db, "TRIP", "OTHER", at)).toBe("20261120-0001");
    expect(await nextDocumentNo(database.db, "TRIP", "XYZ", at)).toBe("20261120-0002");
  });
});
