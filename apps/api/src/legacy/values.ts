// Reading the text values of the old database. Each parser says whether the value was empty, read as it is,
// rounded (a weight with decimals), or could not be read; the importer counts the last two per column and keeps
// their original text.

export type ParseStatus = "EMPTY" | "OK" | "ROUNDED" | "UNPARSED";
export interface Parsed<T> {
  value: T | null;
  status: ParseStatus;
}

const empty = <T>(): Parsed<T> => ({ value: null, status: "EMPTY" });
const unparsed = <T>(): Parsed<T> => ({ value: null, status: "UNPARSED" });

/** The plant's offset from UTC: Asia/Jakarta, which has no daylight saving time. The old times carry no offset. */
export const PLANT_UTC_OFFSET = "+07:00";

/** Trimmed text, or null when absent or blank. Numbers and booleans become their text. */
export function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** The most a weight in kilograms may be: the range of an integer column. */
const MAX_KG = 2_000_000_000;

/** Whole kilograms from "40010", "-120", "30500.6" (rounded) or a JSON number. Thousands separators are not read. */
export function parseKg(value: unknown): Parsed<number> {
  let number: number;
  if (typeof value === "number") number = value;
  else {
    const text = textOf(value);
    if (text === null) return empty();
    if (!/^-?\d+(\.\d+)?$/.test(text)) return unparsed();
    number = Number(text);
  }
  if (!Number.isFinite(number) || Math.abs(number) > MAX_KG) return unparsed();
  const whole = Math.round(number);
  return { value: whole, status: whole === number ? "OK" : "ROUNDED" };
}

/** A number as it is ("0.526", 0.3). */
export function parseNumber(value: unknown): Parsed<number> {
  if (typeof value === "number") return Number.isFinite(value) ? { value, status: "OK" } : unparsed();
  const text = textOf(value);
  if (text === null) return empty();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return unparsed();
  return { value: Number(text), status: "OK" };
}

/** A positive whole number, for the masters: anything else is no value (the table refuses zero and negatives). */
export function positiveInt(value: unknown): number | null {
  const parsed = parseKg(value);
  return parsed.status === "OK" && parsed.value !== null && parsed.value > 0 ? parsed.value : null;
}

const pad = (part: string) => part.padStart(2, "0");

/** Whether year, month and day (and the time) name a real moment. */
function real(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): boolean {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    year >= 1900 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

const DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d{1,6})?)?$/;

/**
 * A time of the plant ("2026-11-20 08:30:00", "2026-11-20 10:5:07", or "2026-11-20T08:40:00.25" from a timestamp
 * column) as ISO text with the plant's offset. A date without a time is not read as midnight.
 */
export function parseDateTime(value: unknown): Parsed<string> {
  const text = textOf(value);
  if (text === null) return empty();
  const match = DATE_TIME.exec(text);
  if (!match) return unparsed();
  const [, year, month, day, hour, minute, second = "0", fraction = ""] = match as unknown as string[];
  if (!real(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second))) return unparsed();
  return { value: `${year}-${pad(month as string)}-${pad(day as string)}T${pad(hour as string)}:${pad(minute as string)}:${pad(second)}${fraction}${PLANT_UTC_OFFSET}`, status: "OK" };
}

/** A calendar date ("2026-11-20", or the date part of a time) as YYYY-MM-DD. */
export function parseDate(value: unknown): Parsed<string> {
  const text = textOf(value);
  if (text === null) return empty();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(text);
  if (!match) return unparsed();
  const [, year, month, day] = match as unknown as string[];
  if (!real(Number(year), Number(month), Number(day))) return unparsed();
  return { value: `${year}-${pad(month as string)}-${pad(day as string)}`, status: "OK" };
}

/** 1 or "1" (or true) is set, 0, "0" or false is not set; anything else is no value. */
export function flagOf(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** The non-empty columns of an old row, strings trimmed, without the columns named in `drop`. */
export function compact(row: Record<string, unknown> | null | undefined, drop: Iterable<string> = []): Record<string, unknown> {
  const dropped = new Set(drop);
  const kept: Record<string, unknown> = {};
  if (!row) return kept;
  for (const [key, value] of Object.entries(row)) {
    if (dropped.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") kept[key] = trimmed;
    } else kept[key] = value;
  }
  return kept;
}
