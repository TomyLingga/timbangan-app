// The machine key of a station: `st<station id>.<43 random characters>`. The number says which station row to
// compare with; only the SHA-256 of the whole key is stored, and the comparison takes the same time whatever
// the input.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PATTERN = /^st([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})$/;

export const hashStationKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

/** A new key for the station and the hash to store. The key is shown once and never kept. */
export function generateStationKey(stationId: number): { key: string; hash: string } {
  const key = `st${stationId}.${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashStationKey(key) };
}

/** The station number a key names, or null when the text is not a station key. */
export function stationIdOfKey(key: string): number | null {
  const match = KEY_PATTERN.exec(key);
  return match ? Number(match[1]) : null;
}

/** Whether the key hashes to the stored value; compared in constant time. */
export function keyMatches(storedHash: string | null, key: string): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashStationKey(key), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
