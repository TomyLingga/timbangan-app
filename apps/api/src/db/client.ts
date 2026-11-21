import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** The Drizzle query builder, whichever driver is underneath. */
export type Orm = PgDatabase<PgQueryResultHKT, Record<string, never>>;

/** Plain SQL next to the query builder: what the migrator and the tests need. */
export interface SqlRunner {
  /** One statement with $1, $2 … parameters; answers its rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Several statements without parameters, as in a migration file. */
  script(text: string): Promise<void>;
}

export interface Database extends SqlRunner {
  db: Orm;
  driver: "pglite" | "postgres";
  /** Runs the callback in one transaction; a throw rolls everything back. */
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * `pglite://memory` and `pglite://<folder>` run PostgreSQL in this process (tests, local development);
 * `postgres://…` connects to a server.
 */
export async function createDb(url: string): Promise<Database> {
  if (url.startsWith("pglite://")) return createPglite(url.slice("pglite://".length));
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return createPostgres(url);
  throw new Error("DATABASE_URL must start with pglite://, postgres:// or postgresql://");
}

async function createPglite(location: string): Promise<Database> {
  if (location !== "memory") await mkdir(dirname(location), { recursive: true });
  const client = location === "memory" ? new PGlite() : new PGlite(location);
  await client.waitReady;
  const runner = (target: Pick<PGlite, "query" | "exec">): SqlRunner => ({
    query: async <T>(text: string, params: unknown[] = []) => (await target.query<T>(text, params)).rows,
    script: async (text) => {
      await target.exec(text);
    },
  });
  return {
    ...runner(client),
    db: drizzlePglite(client),
    driver: "pglite",
    transaction: (callback) => client.transaction((tx) => callback(runner(tx))),
    close: async () => {
      if (!client.closed) await client.close();
    },
  };
}

/** Type oids whose values `query()` answers the way PGlite does. */
const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;
const DATE = 1082;
const INT8 = 20;

/**
 * Drizzle's postgres.js driver switches the client's date and time parsers and serializers, and its json
 * serializers, to pass values through unchanged: its typed columns convert them themselves. Raw `query()` has no
 * columns, so without this a Date parameter cannot be sent at all and a timestamp comes back as server text.
 */
function toParam(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

function likePglite(rows: postgres.RowList<postgres.Row[]>): Record<string, unknown>[] {
  const convert = new Map<string, (value: unknown) => unknown>();
  for (const column of rows.columns ?? []) {
    if (column.type === TIMESTAMPTZ || column.type === TIMESTAMP || column.type === DATE) convert.set(column.name, (value) => new Date(value as string));
    else if (column.type === INT8) convert.set(column.name, (value) => Number(value));
  }
  if (convert.size === 0) return [...rows];
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [name, to] of convert) if (out[name] !== null && out[name] !== undefined) out[name] = to(out[name]);
    return out;
  });
}

function createPostgres(url: string): Database {
  const client = postgres(url);
  type Target = Pick<typeof client, "unsafe">;
  const runner = (target: Target): SqlRunner => ({
    query: async <T>(text: string, params: unknown[] = []) => {
      const rows = await target.unsafe(text, params.map(toParam) as never[]);
      return likePglite(rows) as T[];
    },
    script: async (text) => {
      await target.unsafe(text).simple();
    },
  });
  return {
    ...runner(client),
    db: drizzlePostgres(client),
    driver: "postgres",
    transaction: async <T>(callback: (tx: SqlRunner) => Promise<T>) => (await client.begin((tx) => callback(runner(tx)))) as T,
    close: () => client.end(),
  };
}
