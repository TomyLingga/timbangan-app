// Accounts and their roles, for the system admin.
import { and, asc, count, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { writeAudit } from "../audit.js";
import { accountOf, type Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { authSessions, partners, roles, userRoles, users } from "../db/schema.js";
import { AppError, invalid, notFound } from "../errors.js";
import { idParams, likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({ q: searchParam, limit: limitParam });
const rolesBody = z.object({ roles: z.array(z.string("Peran harus berupa kode peran."), "roles harus berupa daftar kode peran.") });
const activeBody = z.object({ isActive: z.boolean("isActive harus true atau false.") });

const userColumns = {
  id: users.id,
  kind: users.kind,
  username: users.username,
  fullName: users.fullName,
  employeeNo: users.employeeNo,
  partnerId: partners.id,
  partnerName: partners.name,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
};

async function rolesOf(orm: Orm, userIds: number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return found;
  const rows = await orm
    .selectDistinct({ userId: userRoles.userId, code: userRoles.roleCode })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds))
    .orderBy(asc(userRoles.roleCode));
  for (const row of rows) found.get(row.userId)?.push(row.code);
  return found;
}

async function listUsers(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm.select(userColumns).from(users).leftJoin(partners, eq(partners.id, users.partnerId)).where(where).orderBy(asc(sql`lower(${users.username})`)).limit(limit);
  const roleCodes = await rolesOf(orm, rows.map((row) => row.id));
  return rows.map(({ partnerId, partnerName, ...user }) => ({
    id: user.id,
    kind: user.kind,
    username: user.username,
    fullName: user.fullName,
    employeeNo: user.employeeNo,
    partner: partnerId !== null && partnerName !== null ? { id: partnerId, name: partnerName } : null,
    roles: roleCodes.get(user.id) ?? [],
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
  }));
}

export function registerUserAdminRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const admin = { preHandler: [guards.authenticate, guards.requireRole("SUPER_ADMIN")] };
  const one = async (db: Orm, id: number) => {
    const [user] = await listUsers(db, eq(users.id, id), 1);
    if (!user) throw notFound("Akun");
    return user;
  };

  app.get("/api/admin/users", admin, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = pattern ? or(ilike(users.username, pattern), ilike(users.fullName, pattern), ilike(users.employeeNo, pattern)) : undefined;
    const [counted] = await orm.select({ total: count() }).from(users).where(where);
    return { items: await listUsers(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.get("/api/admin/roles", admin, async () => ({ items: await orm.select().from(roles).orderBy(asc(roles.code)) }));

  app.put("/api/admin/users/:id/roles", admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const wanted = [...new Set(rolesBody.parse(request.body).roles)].sort();
    const actor = accountOf(request);
    const now = context.now();

    return orm.transaction(async (tx) => {
      const user = await one(tx, id);
      const known = new Map((await tx.select().from(roles)).map((role) => [role.code, role.scope]));
      for (const code of wanted) {
        if (!known.has(code)) throw invalid("roles", `Peran ${code} tidak ada.`);
        if (known.get(code) !== user.kind) throw invalid("roles", `Peran ${code} bukan untuk akun ${user.kind}.`);
      }
      if (id === actor.id && user.roles.includes("SUPER_ADMIN") && !wanted.includes("SUPER_ADMIN")) {
        throw new AppError(409, "LAST_ADMIN_SELF", "Anda tidak dapat mencabut peran SUPER_ADMIN dari akun sendiri.");
      }
      if (wanted.join() === user.roles.join()) return { user };

      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      if (wanted.length > 0) await tx.insert(userRoles).values(wanted.map((roleCode) => ({ userId: id, roleCode, grantedBy: actor.id, grantedAt: now })));
      await writeAudit(tx, request, now, { action: "USER_ROLES_SET", entityType: "user", entityId: id, before: { roles: user.roles }, after: { roles: wanted } });
      return { user: { ...user, roles: wanted } };
    });
  });

  app.patch("/api/admin/users/:id", admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const { isActive } = activeBody.parse(request.body);
    if (id === accountOf(request).id) throw new AppError(409, "SELF_CHANGE", "Anda tidak dapat mengubah status akun sendiri.");
    const now = context.now();

    return orm.transaction(async (tx) => {
      const user = await one(tx, id);
      if (user.isActive === isActive) return { user };

      await tx.update(users).set({ isActive, updatedAt: now }).where(eq(users.id, id));
      // An account that is switched off loses its sessions at once; its access tokens stop at the next request.
      if (!isActive) await tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.userId, id), isNull(authSessions.revokedAt)));
      await writeAudit(tx, request, now, {
        action: isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED",
        entityType: "user",
        entityId: id,
        before: { isActive: user.isActive },
        after: { isActive },
      });
      return { user: { ...user, isActive } };
    });
  });
}
