// Old masters into the working tables: trucks into vehicles, unused seal numbers into seals, card UIDs into
// rfid_cards. Nothing that exists is changed: a plate, seal number or card already in the table is skipped.
// Imported trucks are verified (verified_at = the import time), so their master tare counts in the tare check.
import { lettersAndDigits } from "../http.js";
import { normaliseUid } from "../rfid-cards/routes.js";
import { defaultSite } from "../settings.js";
import { bump, newCounts, type PartContext, type PartCounts } from "./counts.js";
import type { LegacyRow } from "./reader.js";
import { parseDate, positiveInt, textOf } from "./values.js";

/** The vehicle type for a truck whose old type names none of the known kinds; the run reports how many. */
export const FALLBACK_VEHICLE_TYPE = "TANGKI";

/** An old truck type ("TANGKI", "Dump Truck") as a vehicle_types code. */
export function vehicleTypeOf(type: unknown): { code: string; fallback: boolean } {
  const text = (textOf(type) ?? "").toUpperCase();
  const rules: [RegExp, string][] = [
    [/\bISO/, "ISO_TANK"],
    [/TANG?KI|TANK/, "TANGKI"],
    [/KONTAINER|CONTAINER/, "KONTAINER"],
    [/DUMP/, "DUMP_TRUCK"],
    [/\bBOX\b/, "BOX"],
    [/\bBAK\b/, "BAK"],
  ];
  const found = rules.find(([pattern]) => pattern.test(text));
  return found ? { code: found[1], fallback: false } : { code: FALLBACK_VEHICLE_TYPE, fallback: true };
}

/** "bk-9202-xb" as "BK 9202 XB": upper case, one space between the parts. */
export const plateDisplayOf = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

const PLATE = /^[A-Z0-9]{3,12}$/;
const OWNERSHIPS = new Set(["SENDIRI", "MITRA"]);
const TARE_REASON = "Tarra master truk dari aplikasi lama";

/** The members of `wanted` already in a table column, read with one jsonb array parameter ($1) and `extra` after it. */
async function present(context: PartContext, sql: string, wanted: string[], extra: unknown[] = []): Promise<Set<string>> {
  if (wanted.length === 0) return new Set();
  const rows = await context.database.query<{ value: string }>(sql, [JSON.stringify(wanted), ...extra]);
  return new Set(rows.map((row) => row.value));
}

export async function importVehicles(context: PartContext): Promise<PartCounts> {
  const counts = newCounts();
  const trucks = await context.reader.trucks();
  counts.read = trucks.length;
  const seen = new Set<string>();
  const candidates: { values: Record<string, unknown>; fallback: boolean }[] = [];
  for (const truck of trucks) {
    const text = textOf(truck.no_polisi);
    const plateNo = text === null ? "" : lettersAndDigits(text);
    if (!PLATE.test(plateNo)) {
      bump(counts.skipped, "INVALID_PLATE");
      continue;
    }
    if (seen.has(plateNo)) {
      bump(counts.skipped, "DUPLICATE_IN_SOURCE");
      continue;
    }
    seen.add(plateNo);
    candidates.push(vehicleValues(truck, plateNo, text as string, counts));
  }
  const existing = await present(
    context,
    "select plate_no as value from vehicles where plate_no in (select jsonb_array_elements_text($1::jsonb))",
    candidates.map((candidate) => candidate.values.plate_no as string),
  );
  const fresh = candidates.filter((candidate) => !existing.has(candidate.values.plate_no as string));
  bump(counts.skipped, "EXISTS", candidates.length - fresh.length);
  for (const candidate of fresh) if (candidate.fallback) bump(counts.notes, "TYPE_FALLBACK");
  if (context.dryRun) {
    counts.added = fresh.length;
  } else if (fresh.length > 0) {
    const at = context.now().toISOString();
    counts.added = await context.database.transaction(async (tx) => {
      const [result] = await tx.query<{ added: number }>(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as r(plate_no text, plate_display text, vehicle_type_code text, ownership text, capacity_kg integer,
             production_year smallint, tare_kg integer, stnk_valid_until date, tax_valid_until date, kir_valid_until date)
         ), added as (
           insert into vehicles (plate_no, plate_display, vehicle_type_code, ownership, capacity_kg, production_year, tare_kg, stnk_valid_until, tax_valid_until,
             kir_valid_until, verified_at, created_at, updated_at)
           -- verified at the import: the old truck master was the plant's own reference for the tare check.
           -- verified_by stays null (nobody signed it off here); the code reads verified_at alone.
           select plate_no, plate_display, vehicle_type_code, ownership, capacity_kg, production_year, tare_kg, stnk_valid_until, tax_valid_until, kir_valid_until,
             $2::timestamptz, $2::timestamptz, $2::timestamptz
           from input
           on conflict (plate_no) do nothing
           returning id, tare_kg
         ), history as (
           insert into vehicle_tare_history (vehicle_id, tare_kg, source, reason, changed_at)
           select id, tare_kg, 'IMPORT', $3::text, $2::timestamptz from added where tare_kg is not null
           returning id
         )
         select (select count(*) from added)::int as added`,
        [JSON.stringify(fresh.map((candidate) => candidate.values)), at, TARE_REASON],
      );
      await context.committed(tx, 0);
      return Number(result?.added ?? 0);
    });
    // a plate taken between the read and the insert
    bump(counts.skipped, "EXISTS", fresh.length - counts.added);
  }
  if (counts.skipped.EXISTS === 0) delete counts.skipped.EXISTS;
  return counts;
}

function vehicleValues(truck: LegacyRow, plateNo: string, plateText: string, counts: PartCounts) {
  const type = vehicleTypeOf(truck.tipe);
  const date = (column: string) => {
    const parsed = parseDate(truck[column]);
    if (parsed.status === "UNPARSED") bump(counts.unparsed, `ms_truck.${column}`);
    return parsed.value;
  };
  const yearText = textOf(truck.tahun_produksi);
  const year = yearText !== null && /^\d{4}$/.test(yearText) && Number(yearText) >= 1970 && Number(yearText) <= 2100 ? Number(yearText) : null;
  if (yearText !== null && year === null) bump(counts.unparsed, "ms_truck.tahun_produksi");
  const ownership = textOf(truck.status_kepemilikan)?.toUpperCase() ?? null;
  return {
    fallback: type.fallback,
    values: {
      plate_no: plateNo,
      plate_display: plateDisplayOf(plateText),
      vehicle_type_code: type.code,
      ownership: ownership !== null && OWNERSHIPS.has(ownership) ? ownership : null,
      capacity_kg: positiveInt(truck.daya_angkut),
      production_year: year,
      tare_kg: positiveInt(truck.tarra),
      stnk_valid_until: date("stnk"),
      tax_valid_until: date("pajak"),
      kir_valid_until: date("kir"),
    },
  };
}

export async function importSeals(context: PartContext, after: number): Promise<PartCounts> {
  const counts = newCounts();
  const site = await defaultSite(context.database.db);
  const seen = new Set<string>();
  let cursor = after;
  for (;;) {
    const batch = await context.reader.unusedSeals(cursor, context.batchSize);
    if (batch.length === 0) break;
    counts.read += batch.length;
    const numbers: string[] = [];
    for (const row of batch) {
      const number = textOf(row.nomor);
      if (number === null) bump(counts.skipped, "EMPTY_NUMBER");
      else if (seen.has(number)) bump(counts.skipped, "DUPLICATE_IN_SOURCE");
      else {
        seen.add(number);
        numbers.push(number);
      }
    }
    const last = Number((batch[batch.length - 1] as LegacyRow).id);
    cursor = Number.isFinite(last) && last > cursor ? last : cursor;
    const lookup = "select seal_no as value from seals where site_id = $2 and kind = 'LOCIS' and seal_no in (select jsonb_array_elements_text($1::jsonb))";
    const write = async () => {
      const existing = await present(context, lookup, numbers, [site.id]);
      const fresh = numbers.filter((number) => !existing.has(number));
      bump(counts.skipped, "EXISTS", existing.size);
      return fresh;
    };
    if (context.dryRun) {
      counts.added += (await write()).length;
    } else {
      const fresh = await write();
      await context.database.transaction(async (tx) => {
        if (fresh.length > 0) {
          const made = await tx.query(
            `insert into seals (site_id, seal_no, kind, status, batch_ref, created_at)
             select $2::smallint, value, 'LOCIS', 'AVAILABLE', 'IMPOR-APLIKASI-LAMA', $3::timestamptz from jsonb_array_elements_text($1::jsonb) as value
             on conflict do nothing returning id`,
            [JSON.stringify(fresh), site.id, context.now().toISOString()],
          );
          counts.added += made.length;
          bump(counts.skipped, "EXISTS", fresh.length - made.length);
        }
        await context.committed(tx, cursor);
      });
    }
    if (batch.length < context.batchSize) break;
  }
  if (counts.skipped.EXISTS === 0) delete counts.skipped.EXISTS;
  return counts;
}

const CARD_UID = /^[0-9A-F]{10}$/;

export async function importCards(context: PartContext): Promise<PartCounts> {
  const counts = newCounts();
  const site = await defaultSite(context.database.db);
  const uids = await context.reader.cardUids();
  counts.read = uids.length;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of uids) {
    const text = raw.trim();
    if (text.length !== 10) {
      bump(counts.skipped, "NOT_10_CHARACTERS");
      continue;
    }
    const uid = normaliseUid(text);
    if (!CARD_UID.test(uid)) bump(counts.skipped, "NOT_HEXADECIMAL");
    else if (seen.has(uid)) bump(counts.skipped, "DUPLICATE_IN_SOURCE");
    else {
      seen.add(uid);
      candidates.push(uid);
    }
  }
  const existing = await present(context, "select uid as value from rfid_cards where uid in (select jsonb_array_elements_text($1::jsonb))", candidates);
  const fresh = candidates.filter((uid) => !existing.has(uid));
  bump(counts.skipped, "EXISTS", existing.size);
  if (context.dryRun) counts.added = fresh.length;
  else if (fresh.length > 0) {
    counts.added = await context.database.transaction(async (tx) => {
      // status and label stay at the table's defaults: a free card without a printed number
      const made = await tx.query("insert into rfid_cards (site_id, uid) select $2::smallint, value from jsonb_array_elements_text($1::jsonb) as value on conflict do nothing returning id", [
        JSON.stringify(fresh),
        site.id,
      ]);
      await context.committed(tx, 0);
      return made.length;
    });
    bump(counts.skipped, "EXISTS", fresh.length - counts.added);
  }
  if (counts.skipped.EXISTS === 0) delete counts.skipped.EXISTS;
  return counts;
}
