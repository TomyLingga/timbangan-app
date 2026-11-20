import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../src/db/client.js";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

let database: Database;
const folders: string[] = [];

async function folderWith(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "timbangan-migrations-"));
  folders.push(folder);
  for (const [name, content] of Object.entries(files)) await writeFile(join(folder, name), content);
  return folder;
}

const publicTables = async () =>
  (await database.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1")).map(
    (row) => row.table_name,
  );

beforeEach(async () => {
  database = await createDb("pglite://memory");
});

afterEach(async () => {
  await database.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("migrate", () => {
  it("applies the project's migrations to an empty database and records them", async () => {
    const result = await migrate(database);
    expect(result).toEqual({ applied: ["0001_schema.sql", "0002_seed.sql"], skipped: [] });

    const tables = await publicTables();
    expect(tables).toContain("schema_migrations");
    expect(tables.filter((name) => name !== "schema_migrations")).toHaveLength(47);
    expect(await database.query("select code from sites")).toEqual([{ code: "SMK" }]);
    expect(await database.query("select count(*)::int as n from roles")).toEqual([{ n: 14 }]);

    const recorded = await database.query<{ name: string; checksum: string; applied_at: Date }>(
      "select name, checksum, applied_at from schema_migrations order by name",
    );
    expect(recorded.map((row) => row.name)).toEqual(["0001_schema.sql", "0002_seed.sql"]);
    const text = (await readFile(join(MIGRATIONS_DIR, "0001_schema.sql"), "utf8")).replaceAll("\r\n", "\n");
    expect(recorded[0]?.checksum).toBe(createHash("sha256").update(text).digest("hex"));
    expect(recorded[0]?.applied_at).toBeInstanceOf(Date);
  });

  it("applies nothing on a second run", async () => {
    await migrate(database);
    const result = await migrate(database);
    expect(result).toEqual({ applied: [], skipped: ["0001_schema.sql", "0002_seed.sql"] });
    expect(await database.query("select count(*)::int as n from schema_migrations")).toEqual([{ n: 2 }]);
    expect(await database.query("select count(*)::int as n from sites")).toEqual([{ n: 1 }]);
  });

  it("applies only the files that are new", async () => {
    const dir = await folderWith({ "0001_a.sql": "create table a (id int primary key);" });
    await migrate(database, { dir });
    await writeFile(join(dir, "0002_b.sql"), "create table b (id int primary key);");
    expect(await migrate(database, { dir })).toEqual({ applied: ["0002_b.sql"], skipped: ["0001_a.sql"] });
  });

  it("stops with an error naming the file when an applied file was changed", async () => {
    const dir = await folderWith({
      "0001_a.sql": "create table a (id int primary key);",
      "0002_b.sql": "create table b (id int primary key);",
    });
    await migrate(database, { dir });

    await writeFile(join(dir, "0002_b.sql"), "create table b (id bigint primary key);");
    await writeFile(join(dir, "0003_c.sql"), "create table c (id int primary key);");
    await expect(migrate(database, { dir })).rejects.toThrow(/0002_b\.sql/);
    // nothing after the changed file was applied
    expect(await publicTables()).toEqual(["a", "b", "schema_migrations"]);
  });

  it("treats a file whose line endings changed (CRLF checkout on Windows) as unchanged", async () => {
    const dir = await folderWith({ "0001_a.sql": "create table a (\n  id int primary key\n);\n" });
    await migrate(database, { dir });
    await writeFile(join(dir, "0001_a.sql"), "create table a (\r\n  id int primary key\r\n);\r\n");
    expect(await migrate(database, { dir })).toEqual({ applied: [], skipped: ["0001_a.sql"] });
  });

  it("applies each file in one transaction: a failing file leaves nothing behind", async () => {
    const dir = await folderWith({
      "0001_a.sql": "create table a (id int primary key);",
      "0002_broken.sql": "create table half (id int primary key); insert into missing_table values (1);",
    });
    await expect(migrate(database, { dir })).rejects.toThrow(/0002_broken\.sql/);
    expect(await publicTables()).toEqual(["a", "schema_migrations"]);
    expect(await database.query("select name from schema_migrations")).toEqual([{ name: "0001_a.sql" }]);
  });

  it("applies in file-name order and ignores files that are not .sql", async () => {
    const dir = await folderWith({
      "0002_child.sql": "create table child (id int primary key, parent_id int not null references parent (id));",
      "0001_parent.sql": "create table parent (id int primary key);",
      "notes.md": "not a migration",
    });
    expect(await migrate(database, { dir })).toEqual({ applied: ["0001_parent.sql", "0002_child.sql"], skipped: [] });
  });
});
