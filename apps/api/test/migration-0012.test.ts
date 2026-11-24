// 0012: truck owners follow their trucks, so every partner account that exists gets gps VIEW. A level it already holds
// stays; staff accounts get nothing.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { emptyDatabase } from "./helpers/app.js";

const NAME = "0012_gps_partner_access.sql";
const folders: string[] = [];
let database: Database | undefined;

afterEach(async () => {
  await database?.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("migration 0012", () => {
  it("gives every partner account gps VIEW and keeps a higher level", async () => {
    const dir = await mkdtemp(join(tmpdir(), "timbangan-0012-"));
    folders.push(dir);
    const before = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql") && name < NAME).sort();
    for (const name of before) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    database = await emptyDatabase();
    const db = database;
    expect((await migrate(db, { dir })).applied).toEqual(before);

    const user = async (username: string, kind: "INTERNAL" | "PARTNER", flags: string | null) => {
      const partnerId =
        kind === "PARTNER"
          ? Number((await db.query<{ id: number }>(`insert into partners (name${flags ? `, ${flags}` : ""}) values ($1${flags ? ", true" : ""}) returning id`, [`PT ${username}`]))[0]?.id)
          : null;
      const [row] = await db.query<{ id: number }>("insert into users (kind, partner_id, username, full_name, password_hash) values ($1, $2, $3, $3, 'x') returning id", [
        kind,
        partnerId,
        username,
      ]);
      return Number(row?.id);
    };
    await user("pks", "PARTNER", "is_supplier");
    await user("angkut", "PARTNER", "is_transporter");
    await user("pembeli", "PARTNER", "is_customer");
    await user("polos", "PARTNER", null);
    const lead = await user("pemimpin", "PARTNER", "is_transporter");
    await db.query("insert into user_permissions (user_id, module_code, level) values ($1, 'gps', 'EDIT')", [lead]);
    await user("staf", "INTERNAL", null);

    await copyFile(join(MIGRATIONS_DIR, NAME), join(dir, NAME));
    expect((await migrate(db, { dir })).applied).toEqual([NAME]);

    const rows = await db.query<{ username: string; level: string }>(
      "select u.username, p.level from user_permissions p join users u on u.id = p.user_id where p.module_code = 'gps' order by u.username",
    );
    expect(rows).toEqual([
      { username: "angkut", level: "VIEW" },
      { username: "pembeli", level: "VIEW" },
      { username: "pemimpin", level: "EDIT" },
      { username: "pks", level: "VIEW" },
      { username: "polos", level: "VIEW" },
    ]);
  });
});
