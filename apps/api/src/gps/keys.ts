// The key of a GPS source: `gs<source id>.<43 random characters>`, built like a station key. The number says which
// source row to compare with; only the SHA-256 of the whole key is stored.
import { randomBytes } from "node:crypto";
import { hashStationKey } from "../stations/keys.js";

const KEY_PATTERN = /^gs([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;

/** A new key for the source and the hash to store. The key is shown once and never kept. */
export function generateTrackerKey(sourceId: number): { key: string; hash: string } {
  const key = `gs${sourceId}.${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashStationKey(key) };
}

/** The source number a key names, or null when the text is not a tracker key. */
export function sourceIdOfKey(key: string): number | null {
  const match = KEY_PATTERN.exec(key);
  return match ? Number(match[1]) : null;
}
