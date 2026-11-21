// 0004 moves a database that already has 0001 to 0003 from roles to module permissions. The earlier files are
// applied first from a copy of the folder, rows are written the way the old code wrote them, then 0004 runs.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../src/db/client.js";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

const BEFORE = ["0001_schema.sql", "0002_seed.sql", "0003_registration.sql"];
const folders: string[] = [];
let database: Database | undefined;

afterEach(async () => {
  await database?.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function databaseBefore0004(): Promise<{ db: Database; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "timbangan-0004-"));
  folders.push(dir);
  for (const name of BEFORE) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
  database = await createDb("pglite://memory");
  expect((await migrate(database, { dir })).applied).toEqual(BEFORE);
  return { db: database, dir };
}

const ALL_ACTIVE = ["contracts", "delivery_orders", "destinations", "drivers", "gate", "registrations", "rfid_cards", "users", "vehicles"];

describe("migration 0004", () => {
  it("turns the role assignments into module permissions", async () => {
    const { db, dir } = await databaseBefore0004();
    const user = async (username: string, kind: "INTERNAL" | "PARTNER", partner: string | null, roleCodes: string[]) => {
      const partnerId = partner ? Number((await db.query<{ id: number }>("insert into partners (name) values ($1) returning id", [partner]))[0]?.id) : null;
      const [row] = await db.query<{ id: number }>("insert into users (kind, partner_id, username, full_name, password_hash) values ($1, $2, $3, $3, 'x') returning id", [
        kind, partnerId, username,
      ]);
      for (const code of roleCodes) await db.query("insert into user_roles (user_id, role_code) values ($1, $2)", [row?.id, code]);
    };
    await user("root", "INTERNAL", null, ["SUPER_ADMIN"]);
    await user("logistics", "INTERNAL", null, ["LOGISTICS_ADMIN"]);
    await user("pos", "INTERNAL", null, ["REGISTRATION_OPERATOR"]);
    // two roles: the higher level of each module wins
    await user("both", "INTERNAL", null, ["REGISTRATION_OPERATOR", "LOGISTICS_ADMIN"]);
    await user("qc", "INTERNAL", null, ["QC_OPERATOR", "MANAGEMENT"]);
    await user("pks", "PARTNER", "PKS A", ["PARTNER_SUPPLIER"]);
    await user("angkut", "PARTNER", "Angkut T", ["PARTNER_TRANSPORTER"]);
    await user("pembeli", "PARTNER", "Pembeli C", ["PARTNER_CUSTOMER"]);

    await copyFile(join(MIGRATIONS_DIR, "0004_module_permissions.sql"), join(dir, "0004_module_permissions.sql"));
    expect((await migrate(db, { dir })).applied).toEqual(["0004_module_permissions.sql"]);

    const rows = await db.query<{ username: string; module_code: string; level: string }>(
      "select u.username, p.module_code, p.level from user_permissions p join users u on u.id = p.user_id order by u.username, p.module_code",
    );
    const of = (username: string) => Object.fromEntries(rows.filter((row) => row.username === username).map((row) => [row.module_code, row.level]));
    expect(of("root")).toEqual(Object.fromEntries(ALL_ACTIVE.map((code) => [code, "EDIT"])));
    const logistics = {
      contracts: "EDIT", delivery_orders: "EDIT", destinations: "EDIT", drivers: "EDIT", gate: "EDIT", registrations: "EDIT", rfid_cards: "EDIT", vehicles: "EDIT",
    };
    expect(of("logistics")).toEqual(logistics);
    expect(of("pos")).toEqual({ drivers: "CREATE", gate: "EDIT", registrations: "CREATE", vehicles: "CREATE" });
    expect(of("both")).toEqual(logistics);
    expect(of("qc")).toEqual({});
    expect(of("pks")).toEqual({ contracts: "VIEW", drivers: "CREATE", registrations: "CREATE", vehicles: "CREATE" });
    const deliveries = { delivery_orders: "EDIT", drivers: "CREATE", registrations: "CREATE", vehicles: "CREATE" };
    expect(of("angkut")).toEqual(deliveries);
    expect(of("pembeli")).toEqual(deliveries);

    const tables = (await db.query<{ name: string }>("select table_name as name from information_schema.tables where table_schema = 'public'")).map((row) => row.name);
    expect(tables).not.toContain("roles");
    expect(tables).not.toContain("user_roles");
    expect(tables).toEqual(expect.arrayContaining(["modules", "user_permissions"]));
  });

  it("replaces the role columns of flow_steps, exception_rules and exceptions with module columns", async () => {
    const { db, dir } = await databaseBefore0004();
    // an exception raised under 0003, to see that a row with a role is carried over
    await db.script(`
      insert into partners (name, is_supplier) values ('PKS A', true);
      insert into users (kind, username, full_name, password_hash) values ('INTERNAL', 'op', 'Op', 'x');
      insert into registrations (site_id, reg_no, direction, flow_code, partner_id, status, created_via, created_by)
        select s.id, 'REG-1', 'IN', 'IN_CPO', p.id, 'APPROVED', 'OPERATOR', u.id from sites s, partners p, users u;
      insert into trips (site_id, registration_id, seq, status) select site_id, id, 1, 'DRAFT' from registrations;
      insert into exceptions (site_id, trip_id, type, approver_role, escalated_role) select site_id, id, 'QC_HOLD', 'QC_SUPERVISOR', 'LOGISTICS_SUPERVISOR' from trips;
    `);
    await copyFile(join(MIGRATIONS_DIR, "0004_module_permissions.sql"), join(dir, "0004_module_permissions.sql"));
    await migrate(db, { dir });

    const columns = async (table: string) =>
      (await db.query<{ name: string }>("select column_name as name from information_schema.columns where table_name = $1 order by 1", [table])).map((row) => row.name);
    expect(await columns("flow_steps")).toContain("performer_module");
    expect(await columns("flow_steps")).not.toContain("performer_role");
    expect(await columns("exception_rules")).toEqual(expect.arrayContaining(["approver_module", "escalate_module"]));
    expect((await columns("exception_rules")).filter((name) => name.endsWith("_role"))).toEqual([]);
    expect(await columns("exceptions")).toEqual(expect.arrayContaining(["approver_module", "escalated_module"]));
    expect((await columns("exceptions")).filter((name) => name.endsWith("_role"))).toEqual([]);

    expect(
      await db.query("select performer_module as module, count(*)::int as n from flow_steps group by 1 order by 1 nulls first"),
    ).toEqual([
      { module: null, n: 8 },
      { module: "gate", n: 8 },
      { module: "loading", n: 2 },
      { module: "qc", n: 5 },
      { module: "sealing", n: 3 },
      { module: "security_check", n: 2 },
      { module: "unloading", n: 2 },
    ]);
    expect(await db.query("select type, approver_module, escalate_module from exception_rules order by type")).toEqual([
      { type: "GROSS_IN", approver_module: "approvals", escalate_module: null },
      { type: "NET_IN", approver_module: "approvals", escalate_module: null },
      { type: "NET_OUT", approver_module: "approvals", escalate_module: null },
      { type: "PLATE", approver_module: "approvals", escalate_module: null },
      { type: "QC_HOLD", approver_module: "qc_approvals", escalate_module: null },
      { type: "TARE_OUT", approver_module: "approvals", escalate_module: null },
    ]);
    expect(await db.query("select approver_module, escalated_module from exceptions")).toEqual([{ approver_module: "qc_approvals", escalated_module: "approvals" }]);

    // the new columns point at modules
    await expect(db.script("update exception_rules set approver_module = 'nope'")).rejects.toThrow();
    await expect(db.script("update exception_rules set approver_module = null")).rejects.toThrow();
  });

  it("seeds the modules with their levels, partner flag and state", async () => {
    const { db, dir } = await databaseBefore0004();
    await copyFile(join(MIGRATIONS_DIR, "0004_module_permissions.sql"), join(dir, "0004_module_permissions.sql"));
    await migrate(db, { dir });
    const modules = await db.query<{ code: string; levels: string[]; partner_allowed: boolean; is_active: boolean }>(
      "select code, levels, partner_allowed, is_active from modules order by sort_order",
    );
    expect(modules.filter((row) => row.is_active).map((row) => [row.code, row.levels.join(","), row.partner_allowed])).toEqual([
      ["contracts", "VIEW,EDIT", true],
      ["drivers", "VIEW,CREATE,EDIT", true],
      ["vehicles", "VIEW,CREATE,EDIT", true],
      ["destinations", "VIEW,CREATE,EDIT", false],
      ["delivery_orders", "VIEW,CREATE,EDIT", true],
      ["registrations", "VIEW,CREATE,EDIT", true],
      ["gate", "VIEW,CREATE,EDIT", false],
      ["rfid_cards", "VIEW,CREATE,EDIT", false],
      ["users", "VIEW,EDIT", false],
    ]);
    expect(modules.filter((row) => !row.is_active).map((row) => row.code)).toEqual([
      "weighbridge", "approvals", "qc", "qc_approvals", "security_check", "unloading", "loading", "sealing", "dashboard", "reports",
    ]);
    expect(modules.filter((row) => !row.is_active && row.partner_allowed)).toEqual([]);
  });
});
