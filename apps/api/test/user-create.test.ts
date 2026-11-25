import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { runUserCreate } from "../src/cli/user-create.js";
import type { Database } from "../src/db/client.js";
import { createUser } from "../src/users/create-user.js";
import { freshDatabase, TEST_JWT_SECRET } from "./helpers/app.js";

const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };

async function partnerId(database: Database, name: string): Promise<number> {
  const [row] = await database.query<{ id: number }>("insert into partners (name, is_transporter) values ($1, true) returning id", [name]);
  return Number(row?.id);
}

/** Runs the CLI against the test's database instead of opening one from DATABASE_URL. */
async function cli(database: Database, args: string[], extraEnv: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await runUserCreate(args, { ...env, ...extraEnv }, (line) => lines.push(line), async () => ({ ...database, close: async () => {} }));
  return { code, output: lines.join("\n") };
}

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse")).toBe(false);
  });

  it("answers false for a stored value that is not a hash", async () => {
    expect(await verifyPassword("x", "anything")).toBe(false);
  });
});

const permissionsOf = async (database: Database, id: number) =>
  Object.fromEntries(
    (await database.query<{ module_code: string; level: string }>("select module_code, level from user_permissions where user_id = $1 order by module_code", [id])).map(
      (row) => [row.module_code, row.level],
    ),
  );

const EVERY_ACTIVE_MODULE = {
  contracts: "EDIT", delivery_orders: "EDIT", drivers: "EDIT", gate: "EDIT", registrations: "EDIT", rfid_cards: "EDIT", users: "EDIT", vehicles: "EDIT",
  weighbridge: "EDIT", approvals: "EDIT", qc: "EDIT", qc_approvals: "EDIT", security_check: "EDIT", unloading: "EDIT", loading: "EDIT", sealing: "EDIT", reports: "VIEW", plant_masters: "EDIT",
  dashboard: "VIEW", gps: "EDIT", gate_emergency: "VIEW", shipment_requests: "EDIT",
};

describe("createUser", () => {
  it("creates a staff account with a password and without any permission", async () => {
    const database = await freshDatabase();
    const { id } = await createUser(database.db, { username: "Darurat", fullName: "Admin Darurat", kind: "INTERNAL", password: "s3cret-s3cret" });

    const [row] = await database.query<{ username: string; kind: string; password_hash: string; partner_id: number | null }>(
      "select username, kind, password_hash, partner_id from users where id = $1",
      [id],
    );
    expect(row).toMatchObject({ username: "Darurat", kind: "INTERNAL", partner_id: null });
    expect(await verifyPassword(row?.password_hash ?? "", "s3cret-s3cret")).toBe(true);
    expect(await permissionsOf(database, id)).toEqual({});
  });

  it("gives an admin EDIT on every active module and nothing on the modules of later phases", async () => {
    const database = await freshDatabase();
    const { id } = await createUser(database.db, { username: "darurat", fullName: "Admin Darurat", kind: "INTERNAL", admin: true, password: "s3cret-s3cret" });
    expect(await permissionsOf(database, id)).toEqual(EVERY_ACTIVE_MODULE);
  });

  it("gives a partner account the defaults of its company's kinds", async () => {
    const database = await freshDatabase();
    const company = async (name: string, flags: string) =>
      Number((await database.query<{ id: number }>(`insert into partners (name, ${flags}) values ($1, ${flags.split(",").map(() => "true").join(", ")}) returning id`, [name]))[0]?.id);
    const make = async (username: string, partnerId: number) =>
      (await createUser(database.db, { username, fullName: username, kind: "PARTNER", partnerId, password: "s3cret-s3cret" })).id;

    // every truck owner may follow its trucks (gps VIEW), whatever the kinds of its company
    const supplier = { contracts: "VIEW", drivers: "CREATE", gps: "VIEW", registrations: "CREATE", shipment_requests: "VIEW", vehicles: "CREATE" };
    const deliveries = { delivery_orders: "EDIT", drivers: "CREATE", gps: "VIEW", registrations: "CREATE", vehicles: "CREATE" };
    expect(await permissionsOf(database, await make("pks", await company("PKS A", "is_supplier")))).toEqual(supplier);
    expect(await permissionsOf(database, await make("angkut", await company("Angkut T", "is_transporter")))).toEqual(deliveries);
    expect(await permissionsOf(database, await make("pembeli", await company("Pembeli C", "is_customer")))).toEqual(deliveries);
    expect(await permissionsOf(database, await make("serba", await company("Serba D", "is_supplier, is_transporter")))).toEqual({ ...supplier, ...deliveries });
    const plain = Number((await database.query<{ id: number }>("insert into partners (name) values ('Tanpa jenis') returning id"))[0]?.id);
    expect(await permissionsOf(database, await make("plain", plain))).toEqual({ gps: "VIEW" });
  });

  it("refuses what would be a wrong or duplicate account, and leaves no row behind", async () => {
    const database = await freshDatabase();
    const company = await partnerId(database, "Transporter T");
    const staff = { username: "admin", fullName: "Admin", kind: "INTERNAL", password: "s3cret-s3cret" } as const;

    await expect(createUser(database.db, { ...staff, partnerId: company })).rejects.toThrow(/partner/i);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER" })).rejects.toThrow(/partner/i);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER", partnerId: 999_999 })).rejects.toThrow(/999999/);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER", partnerId: company, admin: true })).rejects.toThrow(/--admin/);
    await expect(createUser(database.db, { ...staff, password: "short" })).rejects.toThrow(/8 characters/);
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 0 }]);

    await createUser(database.db, staff);
    await expect(createUser(database.db, { ...staff, username: "ADMIN" })).rejects.toThrow(/already/);
  });
});

describe("user:create command", () => {
  it("takes the password from NEW_USER_PASSWORD and does not print it", async () => {
    const database = await freshDatabase();
    const { code, output } = await cli(database, ["--username", "darurat", "--full-name", "Admin Darurat", "--kind", "INTERNAL", "--admin"], {
      NEW_USER_PASSWORD: "from-the-environment",
    });
    expect(code).toBe(0);
    expect(output).toContain("darurat");
    expect(output).not.toContain("from-the-environment");
    const [row] = await database.query<{ id: number; password_hash: string }>("select id::int as id, password_hash from users where username = 'darurat'");
    expect(await verifyPassword(row?.password_hash ?? "", "from-the-environment")).toBe(true);
    expect(await permissionsOf(database, Number(row?.id))).toEqual(EVERY_ACTIVE_MODULE);
  });

  it("generates a password and prints it once when the variable is absent", async () => {
    const database = await freshDatabase();
    const company = await partnerId(database, "PKS A");
    const { code, output } = await cli(database, [
      "--username", "pks-a", "--full-name", "Admin PKS A", "--kind", "PARTNER", "--partner-id", String(company),
    ]);
    expect(code).toBe(0);
    const generated = /^Password \(shown once\): (\S+)$/m.exec(output)?.[1] ?? "";
    expect(generated.length).toBeGreaterThanOrEqual(20);
    expect(output.split(generated)).toHaveLength(2);
    const [row] = await database.query<{ password_hash: string }>("select password_hash from users where username = 'pks-a'");
    expect(await verifyPassword(row?.password_hash ?? "", generated)).toBe(true);
  });

  it("explains a wrong call and exits with 1", async () => {
    const database = await freshDatabase();
    const missing = await cli(database, ["--username", "x"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("--full-name");
    expect(missing.output).toContain("Usage");

    const wrongKind = await cli(database, ["--username", "x", "--full-name", "X", "--kind", "ROBOT"]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.output).toContain("INTERNAL or PARTNER");

    // --role is gone; parseArgs refuses an option it does not know
    const oldOption = await cli(database, ["--username", "x", "--full-name", "X", "--kind", "INTERNAL", "--role", "SUPER_ADMIN"]);
    expect(oldOption.code).toBe(1);
    expect(oldOption.output).toContain("--role");
    const partnerAdmin = await cli(database, ["--username", "x", "--full-name", "X", "--kind", "PARTNER", "--partner-id", "1", "--admin"]);
    expect(partnerAdmin.code).toBe(1);
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 0 }]);
  });
});
