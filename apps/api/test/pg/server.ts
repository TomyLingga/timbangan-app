// Databases on a real PostgreSQL server for `npm run test:pg`. Every database this run creates is named
// tr_test_<run>_<random>; nothing else on the server is created, changed or dropped.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type Database } from "../../src/db/client.js";

/** What the global setup hands to every test file. */
export interface PgServer {
  /** The server URL from DATABASE_URL; only host, port and credentials are used. */
  url: string;
  /** Part of every database name of this run, so the teardown drops exactly what the run created. */
  run: string;
  /** A database with every migration applied; each fresh database is a copy of it. */
  template: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    pgServer: PgServer | undefined;
  }
}

const NAME = /^tr_test_[a-z0-9_]+$/;

/** Refuses any name outside tr_test_, so a bug here can never drop a real database. */
export function checkedName(name: string): string {
  if (!NAME.test(name)) throw new Error(`refusing to touch database ${JSON.stringify(name)}: only tr_test_ databases`);
  return `"${name}"`;
}

/** The same server, port and account, another database. */
export function urlFor(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * One connection to the maintenance database `postgres`, used only for CREATE DATABASE, DROP DATABASE and
 * reading pg_database. Not template1: a session there would block every CREATE DATABASE without a template.
 */
export function adminClient(serverUrl: string): postgres.Sql {
  return postgres(urlFor(serverUrl, "postgres"), { max: 1, onnotice: () => {} });
}

export async function createDatabase(admin: postgres.Sql, name: string, template: string): Promise<void> {
  await admin.unsafe(`create database ${checkedName(name)} template ${template === "template0" ? "template0" : checkedName(template)}`);
}

export async function dropDatabase(admin: postgres.Sql, name: string): Promise<void> {
  await admin.unsafe(`drop database if exists ${checkedName(name)} with (force)`);
}

/** Names of the databases a run left on the server; a prefix of "tr_test_" lists every run. */
export async function testDatabases(admin: postgres.Sql, prefix: string): Promise<string[]> {
  if (!prefix.startsWith("tr_test_")) throw new Error("only tr_test_ databases are listed");
  const rows = await admin<{ datname: string }[]>`select datname from pg_database where starts_with(datname, ${prefix}) order by datname`;
  return rows.map((row) => row.datname);
}

let admin: postgres.Sql | undefined;

/**
 * A new database on the server: a copy of the migrated template, or empty (`migrated: false`). Closing it also
 * drops it.
 */
export async function serverDatabase(server: PgServer, migrated: boolean): Promise<Database> {
  admin ??= adminClient(server.url);
  const owner = admin;
  const name = `tr_test_${server.run}_${randomBytes(5).toString("hex")}`;
  await createDatabase(owner, name, migrated ? server.template : "template0");
  const database = await createDb(urlFor(server.url, name));
  let dropped = false;
  return {
    ...database,
    close: async () => {
      await database.close();
      if (dropped) return;
      dropped = true;
      await dropDatabase(owner, name);
    },
  };
}

/** Ends the maintenance connection of this test file. */
export async function closeAdmin(): Promise<void> {
  const current = admin;
  admin = undefined;
  await current?.end();
}
