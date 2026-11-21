// Gapless document numbers. One document_counters row per series; taking a number is a single upsert that
// locks the row until the surrounding transaction ends, so two requests never get the same number and a
// rolled-back transaction gives its number back.
import { sql } from "drizzle-orm";
import type { Orm } from "./db/client.js";
import { documentCounters } from "./db/schema.js";
import { PLANT_TIME_ZONE } from "./http.js";

/** The next number of a series, starting at 1. Call it inside the transaction that writes the document. */
export async function takeNumber(orm: Orm, counterKey: string): Promise<number> {
  const [row] = await orm
    .insert(documentCounters)
    .values({ counterKey, lastNo: 1 })
    .onConflictDoUpdate({ target: documentCounters.counterKey, set: { lastNo: sql`${documentCounters.lastNo} + 1` } })
    .returning({ lastNo: documentCounters.lastNo });
  if (!row) throw new Error(`No number was taken for ${counterKey}.`);
  return row.lastNo;
}

/** Year, month and day of a moment at the plant. */
export function plantDateParts(at: Date): { yyyy: string; mm: string; dd: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { yyyy: part("year"), mm: part("month"), dd: part("day") };
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
export const romanMonth = (month: number) => ROMAN[month - 1] ?? String(month);

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** `SPJ/{site}/{yyyy}{mm}/{00001}`, numbered per site per month. */
export function spjNumber(site: string, at: Date, seq: number): string {
  const { yyyy, mm } = plantDateParts(at);
  return `SPJ/${site}/${yyyy}${mm}/${pad(seq, 5)}`;
}

/** `REG/{site}/{yyyy}{mm}/{00001}`, numbered per site per month. */
export function registrationNo(site: string, at: Date, seq: number): string {
  const { yyyy, mm } = plantDateParts(at);
  return `REG/${site}/${yyyy}${mm}/${pad(seq, 5)}`;
}

/** `{yyyymmdd}-{0001}`, numbered per site per day at the plant. */
export function tripNumber(at: Date, seq: number): string {
  const { yyyy, mm, dd } = plantDateParts(at);
  return `${yyyy}${mm}${dd}-${pad(seq, 4)}`;
}

/** A DO number from the pattern in settings.do_number_format (see migration 0003 for the placeholders). */
export function doNumber(format: string, input: { seq: number; site: string; at: Date }): string {
  const { yyyy, mm } = plantDateParts(input.at);
  return format.replace(/\{(seq(?::(\d+))?|site|roman|yyyy|yy|mm)\}/g, (_whole, name: string, width?: string) => {
    if (name.startsWith("seq")) return pad(input.seq, width ? Number(width) : 1);
    if (name === "site") return input.site;
    if (name === "roman") return romanMonth(Number(mm));
    if (name === "yyyy") return yyyy;
    if (name === "yy") return yyyy.slice(2);
    return mm;
  });
}

/** `{0001}/BA-{kind}/{site}/{roman month}/{yyyy}`: a Berita Acara, numbered per kind per site per year. */
export async function nextReportNo(orm: Orm, kind: string, site: string, at: Date): Promise<string> {
  const { yyyy, mm } = plantDateParts(at);
  const seq = await takeNumber(orm, `BA-${kind}/${site}/${yyyy}`);
  return `${pad(seq, 4)}/BA-${kind}/${site}/${romanMonth(Number(mm))}/${yyyy}`;
}

/** Series that have a fixed pattern. */
export type Series = "SPJ" | "REG" | "TRIP";

/** Takes the next number of the series for the site and the plant date of `at`, and formats it. */
export async function nextDocumentNo(orm: Orm, series: Series, site: string, at: Date): Promise<string> {
  const { yyyy, mm, dd } = plantDateParts(at);
  if (series === "TRIP") return tripNumber(at, await takeNumber(orm, `TRIP/${site}/${yyyy}${mm}${dd}`));
  const seq = await takeNumber(orm, `${series}/${site}/${yyyy}/${mm}`);
  return series === "SPJ" ? spjNumber(site, at, seq) : registrationNo(site, at, seq);
}

/** The next DO number of the site: per site per year, in the pattern of settings.do_number_format. */
export async function nextDoNumber(orm: Orm, format: string, site: string, at: Date): Promise<string> {
  const { yyyy } = plantDateParts(at);
  return doNumber(format, { seq: await takeNumber(orm, `DO/${site}/${yyyy}`), site, at });
}
