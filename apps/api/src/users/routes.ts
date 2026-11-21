// Accounts and their module permissions, for the user administration.
import { and, asc, count, eq, ilike, isNull, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { writeAudit } from "../audit.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { countAdmins, PERMISSION_LEVELS, type Permissions, permissionsOf, replacePermissions } from "../auth/permissions.js";
import type { Orm } from "../db/client.js";
import { authSessions, modules, partners, users } from "../db/schema.js";
import { AppError, notFound } from "../errors.js";
import { idParams, likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({ q: searchParam, limit: limitParam });
const LEVEL_MESSAGE = "Tingkat harus VIEW, CREATE, EDIT, atau null.";
const permissionsBody = z.object({
  permissions: z.record(z.string(), z.enum(PERMISSION_LEVELS, LEVEL_MESSAGE).nullable(), "permissions harus berupa objek kode modul ke tingkat."),
});
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

/** Serialises the changes to permissions, so two admins taking their own access away cannot both pass the check. */
const lockAdministration = (orm: Orm) => orm.execute(sql`select pg_advisory_xact_lock(hashtext('user_permissions'))`);

const lastAdmin = () => new AppError(409, "LAST_ADMIN", "Harus ada sedikitnya satu akun internal aktif yang bisa mengatur hak akses.");

/** The same modules at the same levels, whatever the order of the keys. */
const samePermissions = (a: Permissions, b: Permissions) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([code, level]) => b[code] === level);

async function listUsers(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm.select(userColumns).from(users).leftJoin(partners, eq(partners.id, users.partnerId)).where(where).orderBy(asc(sql`lower(${users.username})`)).limit(limit);
  const held = await permissionsOf(orm, rows.map((row) => row.id));
  return rows.map(({ partnerId, partnerName, ...user }) => ({
    id: user.id,
    kind: user.kind,
    username: user.username,
    fullName: user.fullName,
    employeeNo: user.employeeNo,
    partner: partnerId !== null && partnerName !== null ? { id: partnerId, name: partnerName } : null,
    permissions: held.get(user.id) ?? {},
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
  }));
}

export function registerUserAdminRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const viewers = { preHandler: [guards.authenticate, guards.requirePermission("users", "VIEW")] };
  const editors = { preHandler: [guards.authenticate, guards.requirePermission("users", "EDIT")] };
  const one = async (db: Orm, id: number) => {
    const [user] = await listUsers(db, eq(users.id, id), 1);
    if (!user) throw notFound("Akun");
    return user;
  };

  app.get("/api/admin/users", viewers, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = pattern ? or(ilike(users.username, pattern), ilike(users.fullName, pattern), ilike(users.employeeNo, pattern)) : undefined;
    const [counted] = await orm.select({ total: count() }).from(users).where(where);
    return { items: await listUsers(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.get("/api/admin/modules", viewers, async () => ({
    items: await orm
      .select({ code: modules.code, name: modules.name, levels: modules.levels, partnerAllowed: modules.partnerAllowed })
      .from(modules)
      .where(eq(modules.isActive, true))
      .orderBy(asc(modules.sortOrder)),
  }));

  // Replaces every permission of the account: a module left out or set to null is taken away.
  app.put("/api/admin/users/:id/permissions", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = permissionsBody.parse(request.body);
    const actor = accountOf(request);
    const now = context.now();

    return orm.transaction(async (tx) => {
      await lockAdministration(tx);
      const user = await one(tx, id);
      const known = new Map((await tx.select().from(modules).where(eq(modules.isActive, true))).map((module) => [module.code, module]));
      const wanted: Permissions = {};
      const fields: { field: string; message: string }[] = [];
      for (const [code, level] of Object.entries(body.permissions)) {
        const module = known.get(code);
        const field = `permissions.${code}`;
        if (!module) fields.push({ field, message: `Modul ${code} tidak ada.` });
        else if (level === null) continue;
        else if (!module.levels.includes(level)) fields.push({ field, message: `Tingkat ${level} tidak berlaku untuk modul ${code}.` });
        else if (user.kind === "PARTNER" && !module.partnerAllowed) fields.push({ field, message: `Modul ${code} tidak bisa diberikan ke akun partner.` });
        else wanted[code] = level;
      }
      if (fields.length > 0) throw new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", fields);
      if (samePermissions(user.permissions, wanted)) return { user };

      await replacePermissions(tx, id, wanted, actor.id, now);
      if ((await countAdmins(tx)) === 0) throw lastAdmin();
      const changed = await one(tx, id);
      await writeAudit(tx, request, now, {
        action: "USER_PERMISSIONS_SET",
        entityType: "user",
        entityId: id,
        before: { permissions: user.permissions },
        after: { permissions: changed.permissions },
      });
      return { user: changed };
    });
  });

  app.patch("/api/admin/users/:id", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const { isActive } = activeBody.parse(request.body);
    if (id === accountOf(request).id) throw new AppError(409, "SELF_CHANGE", "Anda tidak dapat mengubah status akun sendiri.");
    const now = context.now();

    // the actor holds users:EDIT and cannot switch itself off, so at least one admin stays
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
