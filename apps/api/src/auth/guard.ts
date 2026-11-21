import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import type { Orm } from "../db/client.js";
import { partners, users } from "../db/schema.js";
import { AppError, forbidden } from "../errors.js";
import { covers, type ModuleCode, type PermissionLevel, type Permissions, permissionsOf } from "./permissions.js";
import { verifyAccessToken } from "./tokens.js";

/** The company of a PARTNER account; its flags say which kinds of partner it is. */
export interface AccountPartner {
  id: number;
  name: string;
  isSupplier: boolean;
  isTransporter: boolean;
  isCustomer: boolean;
}

/** The signed-in user as the API shows it. */
export interface Account {
  id: number;
  kind: "INTERNAL" | "PARTNER";
  username: string;
  fullName: string;
  /** Level per active module; a module that is absent cannot be opened. */
  permissions: Permissions;
  partner: AccountPartner | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authenticate`; null on routes that do not ask for a signed-in user. */
    account: Account | null;
  }
}

/** The account with its permissions as they are now, or null when it does not exist or is inactive. */
export async function loadAccount(orm: Orm, userId: number): Promise<Account | null> {
  const [row] = await orm
    .select({
      id: users.id,
      kind: users.kind,
      username: users.username,
      fullName: users.fullName,
      isActive: users.isActive,
      partner: { id: partners.id, name: partners.name, isSupplier: partners.isSupplier, isTransporter: partners.isTransporter, isCustomer: partners.isCustomer },
    })
    .from(users)
    .leftJoin(partners, eq(partners.id, users.partnerId))
    .where(eq(users.id, userId));
  if (!row?.isActive) return null;
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    fullName: row.fullName,
    permissions: (await permissionsOf(orm, [userId])).get(userId) ?? {},
    partner: row.partner,
  };
}

/** Whether the account holds `level` or higher on the module. */
export function can(account: Account, moduleCode: ModuleCode, level: PermissionLevel): boolean {
  return covers(account.permissions[moduleCode], level);
}

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Silakan masuk terlebih dahulu.");

/** The account `authenticate` put on the request. */
export function accountOf(request: FastifyRequest): Account {
  if (!request.account) throw unauthenticated();
  return request.account;
}

export function createGuards(context: AppContext) {
  /** Pre-handler: needs `Authorization: Bearer <access token>` of an active account. */
  async function authenticate(request: FastifyRequest): Promise<void> {
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw unauthenticated();
    const userId = await verifyAccessToken(context.config.jwtSecret, token, context.now());
    const account = userId === null ? null : await loadAccount(context.database.db, userId);
    if (!account) throw unauthenticated();
    request.account = account;
  }

  /** A staff account without any permission gets NO_ACCESS, so the web app can tell it to wait for one. */
  function checkHasAccess(account: Account): void {
    if (account.kind === "INTERNAL" && Object.keys(account.permissions).length === 0) {
      throw new AppError(403, "NO_ACCESS", "Akun Anda belum diberi hak akses. Hubungi admin sistem.");
    }
  }

  /** Pre-handler, after `authenticate`: the account holds at least one of the module levels. */
  function requireAnyPermission(...needs: [ModuleCode, PermissionLevel][]) {
    return async (request: FastifyRequest): Promise<void> => {
      const account = accountOf(request);
      checkHasAccess(account);
      if (!needs.some(([moduleCode, level]) => can(account, moduleCode, level))) throw forbidden();
    };
  }

  /** Pre-handler, after `authenticate`: the account holds `level` or higher on the module. */
  function requirePermission(moduleCode: ModuleCode, level: PermissionLevel) {
    return requireAnyPermission([moduleCode, level]);
  }

  /** Pre-handler, after `authenticate`: a staff account with at least one permission. Partner accounts are refused. */
  async function requireInternal(request: FastifyRequest): Promise<void> {
    const account = accountOf(request);
    if (account.kind !== "INTERNAL") throw forbidden();
    checkHasAccess(account);
  }

  return { authenticate, requirePermission, requireAnyPermission, requireInternal };
}

export type Guards = ReturnType<typeof createGuards>;
