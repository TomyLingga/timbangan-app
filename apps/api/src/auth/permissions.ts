// Access per module: an account holds at most one level per module, and a higher level includes the lower ones.
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { modules, PERMISSION_LEVELS, type PermissionLevel, userPermissions, users } from "../db/schema.js";

export { PERMISSION_LEVELS, type PermissionLevel };

/** The modules the routes check. `dashboard` exists in the table but is not active yet. */
export type ModuleCode =
  | "contracts"
  | "drivers"
  | "vehicles"
  | "destinations"
  | "delivery_orders"
  | "registrations"
  | "gate"
  | "rfid_cards"
  | "users"
  | "weighbridge"
  | "approvals"
  | "qc"
  | "qc_approvals"
  | "security_check"
  | "unloading"
  | "loading"
  | "sealing"
  | "reports"
  | "plant_masters";

/** Module code to level, for the modules the account may open. */
export type Permissions = Record<string, PermissionLevel>;

const RANK: Record<PermissionLevel, number> = { VIEW: 1, CREATE: 2, EDIT: 3 };

/** Whether `held` covers `needed`: EDIT covers CREATE and VIEW, CREATE covers VIEW. */
export function covers(held: PermissionLevel | undefined, needed: PermissionLevel): boolean {
  return held !== undefined && RANK[held] >= RANK[needed];
}

/** The permissions of these users on active modules. */
export async function permissionsOf(orm: Orm, userIds: number[]): Promise<Map<number, Permissions>> {
  const found = new Map<number, Permissions>(userIds.map((id) => [id, {}]));
  if (userIds.length === 0) return found;
  const rows = await orm
    .select({ userId: userPermissions.userId, code: userPermissions.moduleCode, level: userPermissions.level })
    .from(userPermissions)
    .innerJoin(modules, eq(modules.code, userPermissions.moduleCode))
    .where(and(inArray(userPermissions.userId, userIds), eq(modules.isActive, true)))
    .orderBy(asc(modules.sortOrder));
  for (const row of rows) {
    const held = found.get(row.userId);
    if (held) held[row.code] = row.level;
  }
  return found;
}

/**
 * Makes the user's permissions exactly `wanted`: other rows are removed, changed rows get the new level and
 * the granter; rows that stay the same keep who granted them and when. `orm` may be a transaction.
 */
export async function replacePermissions(orm: Orm, userId: number, wanted: Permissions, grantedBy: number | null, now: Date): Promise<void> {
  const codes = Object.keys(wanted);
  await orm
    .delete(userPermissions)
    .where(and(eq(userPermissions.userId, userId), codes.length > 0 ? notInArray(userPermissions.moduleCode, codes) : undefined));
  if (codes.length === 0) return;
  await orm
    .insert(userPermissions)
    .values(codes.map((moduleCode) => ({ userId, moduleCode, level: wanted[moduleCode] as PermissionLevel, grantedBy, grantedAt: now })))
    .onConflictDoUpdate({
      target: [userPermissions.userId, userPermissions.moduleCode],
      set: { level: sql`excluded.level`, grantedBy: sql`excluded.granted_by`, grantedAt: sql`excluded.granted_at` },
      setWhere: sql`${userPermissions.level} <> excluded.level`,
    });
}

/**
 * The highest level of every active module (EDIT for the modules of this phase), for the bootstrap admins and
 * `user:create --admin`. Permissions on other modules stay.
 */
export async function grantEverything(orm: Orm, userId: number, now: Date): Promise<void> {
  await orm.execute(sql`
    insert into user_permissions (user_id, module_code, level, granted_by, granted_at)
    select ${userId}, code, levels[cardinality(levels)], null, ${now.toISOString()}::timestamptz from modules where is_active
    on conflict (user_id, module_code) do update set level = excluded.level, granted_by = null, granted_at = excluded.granted_at
    where user_permissions.level <> excluded.level`);
}

/** What a new partner account gets, from the kinds of its company (supplier, transporter, customer). */
export function partnerDefaults(company: { isSupplier: boolean; isTransporter: boolean; isCustomer: boolean }): Permissions {
  const granted: Permissions = {};
  const raise = (code: ModuleCode, level: PermissionLevel) => {
    if (!covers(granted[code], level)) granted[code] = level;
  };
  if (company.isSupplier) {
    raise("contracts", "VIEW");
    raise("registrations", "CREATE");
    raise("vehicles", "CREATE");
    raise("drivers", "CREATE");
  }
  if (company.isTransporter || company.isCustomer) {
    raise("delivery_orders", "EDIT");
    raise("registrations", "CREATE");
    raise("vehicles", "CREATE");
    raise("drivers", "CREATE");
  }
  return granted;
}

/** Active INTERNAL accounts that hold users:EDIT. */
export async function countAdmins(orm: Orm): Promise<number> {
  const [row] = await orm
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(userPermissions, and(eq(userPermissions.userId, users.id), eq(userPermissions.moduleCode, "users"), eq(userPermissions.level, "EDIT")))
    .where(and(eq(users.isActive, true), eq(users.kind, "INTERNAL")));
  return Number(row?.n ?? 0);
}
