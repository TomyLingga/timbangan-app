// What one part of an import read and did, and the context every part shares.
import type { Database, SqlRunner } from "../db/client.js";
import type { LegacyReader } from "./reader.js";

export const ENTITIES = ["trips", "exceptions", "vehicles", "seals", "cards"] as const;
export type Entity = (typeof ENTITIES)[number];

export interface PartCounts {
  read: number;
  /** New rows (or, on a dry run, rows that would be new). */
  added: number;
  /** Archive rows whose stored values differed and were replaced. Masters are never changed: always 0. */
  changed: number;
  unchanged: number;
  /** Rows not written, per reason code. */
  skipped: Record<string, number>;
  /** Values that could not be read, per "table.column"; the original text is kept in details.original. */
  unparsed: Record<string, number>;
  /** Weights with decimals rounded to whole kilograms, per "table.column". */
  rounded: Record<string, number>;
  /** Other things worth knowing, per code (TYPE_FALLBACK: trucks whose type was not recognised). */
  notes: Record<string, number>;
}

export const newCounts = (): PartCounts => ({ read: 0, added: 0, changed: 0, unchanged: 0, skipped: {}, unparsed: {}, rounded: {}, notes: {} });

export const bump = (counter: Record<string, number>, key: string, by = 1) => {
  counter[key] = (counter[key] ?? 0) + by;
};

export interface PartContext {
  database: Database;
  reader: LegacyReader;
  dryRun: boolean;
  since: string | null;
  batchSize: number;
  now: () => Date;
  /** Called after each committed batch with the last legacy id it held (not on a dry run). */
  committed: (tx: SqlRunner, after: number) => Promise<void>;
}

/** A problem the person running the import can fix; printed as it is. */
export class ImportError extends Error {
  override name = "ImportError";
}
