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

describe("createUser", () => {
  it("creates a staff account with a password and one role", async () => {
    const database = await freshDatabase();
    const { id } = await createUser(database.db, { username: "Darurat", fullName: "Admin Darurat", kind: "INTERNAL", role: "SUPER_ADMIN", password: "s3cret-s3cret" });

    const [row] = await database.query<{ username: string; kind: string; password_hash: string; partner_id: number | null }>(
      "select username, kind, password_hash, partner_id from users where id = $1",
      [id],
    );
    expect(row).toMatchObject({ username: "Darurat", kind: "INTERNAL", partner_id: null });
    expect(await verifyPassword(row?.password_hash ?? "", "s3cret-s3cret")).toBe(true);
    expect(await database.query("select role_code from user_roles where user_id = $1", [id])).toEqual([{ role_code: "SUPER_ADMIN" }]);
  });

  it("creates a partner account for a company", async () => {
    const database = await freshDatabase();
    const company = await partnerId(database, "Transporter T");
    const { id } = await createUser(database.db, {
      username: "transporter-t",
      fullName: "Admin T",
      kind: "PARTNER",
      partnerId: company,
      role: "PARTNER_TRANSPORTER",
      password: "s3cret-s3cret",
    });
    expect(await database.query<{ partner_id: number }>("select partner_id::int as partner_id from users where id = $1", [id])).toEqual([{ partner_id: company }]);
  });

  it("refuses what would be a wrong or duplicate account, and leaves no row behind", async () => {
    const database = await freshDatabase();
    const company = await partnerId(database, "Transporter T");
    const staff = { username: "admin", fullName: "Admin", kind: "INTERNAL", role: "LOGISTICS_ADMIN", password: "s3cret-s3cret" } as const;

    await expect(createUser(database.db, { ...staff, role: "NOT_A_ROLE" })).rejects.toThrow(/NOT_A_ROLE/);
    await expect(createUser(database.db, { ...staff, role: "PARTNER_SUPPLIER" })).rejects.toThrow(/PARTNER_SUPPLIER/);
    await expect(createUser(database.db, { ...staff, partnerId: company })).rejects.toThrow(/partner/i);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER", role: "PARTNER_SUPPLIER" })).rejects.toThrow(/partner/i);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER", role: "PARTNER_SUPPLIER", partnerId: 999_999 })).rejects.toThrow(/999999/);
    await expect(createUser(database.db, { ...staff, kind: "PARTNER", role: "SUPER_ADMIN", partnerId: company })).rejects.toThrow(/SUPER_ADMIN/);
    await expect(createUser(database.db, { ...staff, password: "short" })).rejects.toThrow(/8 characters/);
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 0 }]);

    await createUser(database.db, staff);
    await expect(createUser(database.db, { ...staff, username: "ADMIN" })).rejects.toThrow(/already/);
  });
});

describe("user:create command", () => {
  it("takes the password from NEW_USER_PASSWORD and does not print it", async () => {
    const database = await freshDatabase();
    const { code, output } = await cli(database, ["--username", "darurat", "--full-name", "Admin Darurat", "--kind", "INTERNAL", "--role", "SUPER_ADMIN"], {
      NEW_USER_PASSWORD: "from-the-environment",
    });
    expect(code).toBe(0);
    expect(output).toContain("darurat");
    expect(output).not.toContain("from-the-environment");
    const [row] = await database.query<{ password_hash: string }>("select password_hash from users where username = 'darurat'");
    expect(await verifyPassword(row?.password_hash ?? "", "from-the-environment")).toBe(true);
  });

  it("generates a password and prints it once when the variable is absent", async () => {
    const database = await freshDatabase();
    const company = await partnerId(database, "PKS A");
    const { code, output } = await cli(database, [
      "--username", "pks-a", "--full-name", "Admin PKS A", "--kind", "PARTNER", "--partner-id", String(company), "--role", "PARTNER_SUPPLIER",
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

    const wrongKind = await cli(database, ["--username", "x", "--full-name", "X", "--kind", "ROBOT", "--role", "SUPER_ADMIN"]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.output).toContain("INTERNAL or PARTNER");

    const wrongRole = await cli(database, ["--username", "x", "--full-name", "X", "--kind", "INTERNAL", "--role", "NOPE"]);
    expect(wrongRole.code).toBe(1);
    expect(wrongRole.output).toContain("NOPE");
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 0 }]);
  });
});
