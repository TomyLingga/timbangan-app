// The bootstrap admins get every active module at API start too, not only at sign-in: a long-lived session would
// otherwise miss a module that a later migration added.
import { describe, expect, it, onTestFinished } from "vitest";
import { grantBootstrapAdmins } from "../src/auth/permissions.js";
import type { Database } from "../src/db/client.js";
import { startServer } from "../src/server.js";
import { freshDatabase, TEST_JWT_SECRET } from "./helpers/app.js";

const NOW = new Date("2026-11-24T03:00:00Z");

async function account(database: Database, username: string, sso: string | null, active = true) {
  const [row] = await database.query<{ id: number }>(
    "insert into users (kind, username, full_name, password_hash, sso_subject, is_active) values ('INTERNAL', $1, $1, $2, $3, $4) returning id::float8 as id",
    [username, sso === null ? "x" : null, sso, active],
  );
  return Number(row?.id);
}

const modulesOf = async (database: Database, userId: number) =>
  (await database.query<{ module_code: string; level: string }>("select module_code, level from user_permissions where user_id = $1 order by module_code", [userId])).map(
    (row) => `${row.module_code}:${row.level}`,
  );

describe("grantBootstrapAdmins", () => {
  it("gives every active module to the portal accounts of the listed emails, also under the #sso name", async () => {
    const database = await freshDatabase();
    const first = await account(database, "kepala@contoh.test", "subject-1");
    // a local account held the email first, so the portal account was named <email>#sso
    const local = await account(database, "wakil@contoh.test", null);
    const second = await account(database, "wakil@contoh.test#sso", "subject-2");
    const stopped = await account(database, "lama@contoh.test", "subject-3", false);
    const other = await account(database, "staf@contoh.test", "subject-4");
    // a module that a later migration switches on
    await database.query("update modules set is_active = true where code = 'destinations'");

    const granted = await grantBootstrapAdmins(database.db, [" Kepala@Contoh.test ", "wakil@contoh.test", "lama@contoh.test"], NOW);
    expect(granted).toEqual([first, second]);

    const active = (await database.query<{ code: string; level: string }>("select code, levels[cardinality(levels)] as level from modules where is_active order by code")).map(
      (row) => `${row.code}:${row.level}`,
    );
    expect(active).toContain("destinations:EDIT");
    expect(await modulesOf(database, first)).toEqual(active);
    expect(await modulesOf(database, second)).toEqual(active);
    expect(await modulesOf(database, local)).toEqual([]);
    expect(await modulesOf(database, stopped)).toEqual([]);
    expect(await modulesOf(database, other)).toEqual([]);

    // running it again changes nothing
    expect(await grantBootstrapAdmins(database.db, ["kepala@contoh.test"], NOW)).toEqual([first]);
    expect(await modulesOf(database, first)).toEqual(active);
  });

  it("does nothing for an empty list or an email without an account", async () => {
    const database = await freshDatabase();
    await account(database, "kepala@contoh.test", "subject-1");
    expect(await grantBootstrapAdmins(database.db, [], NOW)).toEqual([]);
    expect(await grantBootstrapAdmins(database.db, ["  "], NOW)).toEqual([]);
    expect(await grantBootstrapAdmins(database.db, ["belum@contoh.test"], NOW)).toEqual([]);
    expect(await database.query("select count(*)::int as n from user_permissions")).toEqual([{ n: 0 }]);
  });
});

describe("startServer with bootstrap admins", () => {
  it("starts when the listed email has no account yet", async () => {
    const { app, address } = await startServer(
      { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, PORT: "0", BOOTSTRAP_ADMIN_EMAILS: "belum@contoh.test" },
      { logger: false },
    );
    onTestFinished(() => app.close());
    expect((await fetch(`${address}/api/health`)).status).toBe(200);
  });
});
