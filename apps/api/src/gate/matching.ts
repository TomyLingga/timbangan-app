// Comparing what the document reading service read with the master data. A reading is a proposal: document
// numbers come back one or two characters off (roman numerals, slashes, O for 0), names with other punctuation.
// These functions only say how near two texts are; which rows are compared is decided by the caller.
import { lettersAndDigits } from "../http.js";

/** The most characters two document numbers may differ and still be offered. */
export const MAX_DISTANCE = 2;
/** Shorter than this, a name is not looked for inside another name. */
const MIN_CONTAINED_LENGTH = 4;

/** O read as 0, and I or L read as 1: the same character once folded. */
export const foldLookalikes = (key: string) => key.replace(/O/g, "0").replace(/[IL]/g, "1");

/**
 * How many single-character changes (insert, delete, replace) turn `a` into `b`; `max + 1` as soon as it is
 * more than `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[b.length] ?? max + 1, max + 1);
}

/** Short texts get less room: none below 4 characters, one below 8, two from there on. */
const allowedDistance = (length: number) => Math.min(MAX_DISTANCE, Math.floor(length / 4));

export interface NearNumber<T> {
  item: T;
  /** Characters that differ between the two numbers. */
  distance: number;
  /** The two are equal once O/0 and I/L/1 count as the same character. */
  lookalikeOnly: boolean;
}

/**
 * The rows whose document number equals the one read, and the ones near it. Numbers are compared in upper case
 * with everything but letters and digits dropped. Near: equal once the lookalikes are folded, or at most two
 * characters apart. Nearest first: lookalikes only, then by distance.
 */
export function compareNumbers<T>(read: string, rows: T[], numberOf: (row: T) => string): { equal: T[]; near: NearNumber<T>[] } {
  const key = lettersAndDigits(read);
  const equal: T[] = [];
  const near: NearNumber<T>[] = [];
  if (!key) return { equal, near };
  const folded = foldLookalikes(key);
  const allowed = allowedDistance(key.length);
  for (const row of rows) {
    const other = lettersAndDigits(numberOf(row));
    if (other === key) equal.push(row);
    else if (foldLookalikes(other) === folded) {
      // same length, so the characters that differ are the folded ones
      let distance = 0;
      for (let index = 0; index < key.length; index++) if (key[index] !== other[index]) distance++;
      near.push({ item: row, distance, lookalikeOnly: true });
    } else if (allowed > 0) {
      const distance = editDistance(key, other, allowed);
      if (distance <= allowed) near.push({ item: row, distance, lookalikeOnly: false });
    }
  }
  near.sort((a, b) => Number(b.lookalikeOnly) - Number(a.lookalikeOnly) || a.distance - b.distance);
  return { equal, near };
}

/** A name in upper case with every run of other characters as one space: "PT. Contoh, Tbk" is "PT CONTOH TBK". */
export const nameKey = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Words that say what kind of company it is, not which one. */
const LEGAL_FORMS = new Set(["PT", "CV", "UD", "FA", "TBK", "PERSERO"]);

/** The key of a company name without its legal form: "PT. Contoh Angkutan" and "CONTOH ANGKUTAN, PT" are the same. */
export const companyKey = (text: string) =>
  nameKey(text)
    .split(" ")
    .filter((word) => word !== "" && !LEGAL_FORMS.has(word))
    .join(" ");

export interface NearName<T> {
  item: T;
  /** Characters that differ; null when one name only contains the other. */
  distance: number | null;
}

/**
 * The rows whose name has the same key as the one read (spaces not counted), and the ones near it: at most two
 * characters apart, or one name inside the other, as the partner and driver searches match a typed word.
 * Nearest first; names that only contain each other come last, the closest in length first.
 */
export function compareNames<T>(read: string, rows: T[], nameOf: (row: T) => string, keyOf: (text: string) => string = nameKey): { equal: T[]; near: NearName<T>[] } {
  const key = keyOf(read);
  const equal: T[] = [];
  const found: (NearName<T> & { gap: number })[] = [];
  if (!key) return { equal, near: [] };
  const compact = key.replace(/ /g, "");
  const allowed = allowedDistance(compact.length);
  for (const row of rows) {
    const other = keyOf(nameOf(row));
    if (!other) continue;
    const otherCompact = other.replace(/ /g, "");
    // a space the reading dropped or added does not make another name
    if (otherCompact === compact) {
      equal.push(row);
      continue;
    }
    const distance = allowed > 0 ? editDistance(compact, otherCompact, allowed) : allowed + 1;
    if (distance <= allowed) found.push({ item: row, distance, gap: 0 });
    else if (Math.min(key.length, other.length) >= MIN_CONTAINED_LENGTH && (other.includes(key) || key.includes(other))) {
      found.push({ item: row, distance: null, gap: Math.abs(other.length - key.length) });
    }
  }
  found.sort((a, b) => (a.distance ?? MAX_DISTANCE + 1) - (b.distance ?? MAX_DISTANCE + 1) || a.gap - b.gap);
  return { equal, near: found.map(({ item, distance }) => ({ item, distance })) };
}
