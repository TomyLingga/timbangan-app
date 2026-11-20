import { asc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import type { Orm } from "../db/client.js";
import { partners, userRoles, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { verifyAccessToken } from "./tokens.js";

/** The signed-in user as the API shows it. */
export interface Account {
  id: number;
  kind: "INTERNAL" | "PARTNER";
  username: string;
  fullName: string;
  roles: string[];
  partner: { id: number; name: string } | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authenticate`; null on routes that do not ask for a signed-in user. */
    account: Account | null;
  }
}

/** The account with its roles as they are now, or null when it does not exist or is inactive. */
export async function loadAccount(orm: Orm, userId: number): Promise<Account | null> {
  const [row] = await orm
    .select({ id: users.id, kind: users.kind, username: users.username, fullName: users.fullName, isActive: users.isActive, partnerId: partners.id, partnerName: partners.name })
    .from(users)
    .leftJoin(partners, eq(partners.id, users.partnerId))
    .where(eq(users.id, userId));
  if (!row?.isActive) return null;
  const roleRows = await orm.selectDistinct({ code: userRoles.roleCode }).from(userRoles).where(eq(userRoles.userId, userId)).orderBy(asc(userRoles.roleCode));
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    fullName: row.fullName,
    roles: roleRows.map((role) => role.code),
    partner: row.partnerId !== null && row.partnerName !== null ? { id: row.partnerId, name: row.partnerName } : null,
  };
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

  /**
   * Pre-handler, after `authenticate`: the account needs one of the codes; SUPER_ADMIN passes every check.
   * A staff account without any role gets NO_ROLE, so the web app can tell it to ask for one.
   * Without codes every staff role and every partner account passes.
   */
  function requireRole(...codes: string[]) {
    return async (request: FastifyRequest): Promise<void> => {
      const account = accountOf(request);
      if (account.kind === "INTERNAL" && account.roles.length === 0) {
        throw new AppError(403, "NO_ROLE", "Akun Anda belum diberi peran. Hubungi admin sistem.");
      }
      if (codes.length === 0 || account.roles.includes("SUPER_ADMIN")) return;
      if (!codes.some((code) => account.roles.includes(code))) throw new AppError(403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
    };
  }

  return { authenticate, requireRole };
}

export type Guards = ReturnType<typeof createGuards>;
