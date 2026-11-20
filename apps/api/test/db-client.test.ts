import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../src/db/client.js";

const open: Database[] = [];
const folders: string[] = [];

async function opened(url: string): Promise<Database> {
  const database = await createDb(url);
  open.push(database);
  return database;
}

afterEach(async () => {
  for (const database of open.splice(0)) await database.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("createDb", () => {
  it("opens an in-process PostgreSQL for pglite://memory", async () => {
    const database = await opened("pglite://memory");
    expect(database.driver).toBe("pglite");
    expect(await database.query<{ n: number }>("select $1::int + 1 as n", [41])).toEqual([{ n: 42 }]);
  });

  it("gives a Drizzle instance on the same database", async () => {
    const database = await opened("pglite://memory");
    await database.script("create table t (id int primary key, label text); insert into t values (1, 'a'), (2, 'b');");
    const t = pgTable("t", { id: integer().primaryKey(), label: text() });
    expect(await database.db.select().from(t).orderBy(t.id)).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ]);
  });

  it("runs a raw transaction and rolls it back when the callback throws", async () => {
    const database = await opened("pglite://memory");
    await database.script("create table t (id int primary key)");
    await database.transaction(async (tx) => {
      await tx.query("insert into t values ($1)", [1]);
    });
    await expect(
      database.transaction(async (tx) => {
        await tx.script("insert into t values (2); insert into t values (3);");
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await database.query("select id from t order by id")).toEqual([{ id: 1 }]);
  });

  it("keeps the data of pglite://<folder> between two openings, creating the folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "timbangan-api-"));
    folders.push(root);
    const url = `pglite://${join(root, "nested", "dev")}`;

    const first = await createDb(url);
    await first.script("create table kept (id int primary key); insert into kept values (7);");
    await first.close();

    const second = await opened(url);
    expect(await second.query("select id from kept")).toEqual([{ id: 7 }]);
  });

  it("builds a postgres.js client for postgres:// without connecting", async () => {
    // Nothing listens on port 1: creating and closing must not need a connection.
    const database = await opened("postgres://nobody:nothing@127.0.0.1:1/none");
    expect(database.driver).toBe("postgres");
  });

  it("can be closed twice", async () => {
    const database = await createDb("pglite://memory");
    await database.close();
    await expect(database.close()).resolves.toBeUndefined();
  });

  it("refuses an unknown scheme", async () => {
    await expect(createDb("mysql://127.0.0.1/x")).rejects.toThrow(/DATABASE_URL/);
  });
});
