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

function createPostgres(url: string): Database {
  const client = postgres(url);
  type Target = Pick<typeof client, "unsafe">;
  const runner = (target: Target): SqlRunner => ({
    query: async <T>(text: string, params: unknown[] = []) => {
      const rows = await target.unsafe(text, params as never[]);
      return [...rows] as T[];
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
