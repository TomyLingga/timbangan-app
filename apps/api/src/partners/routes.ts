import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { partners } from "../db/schema.js";
import { likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({
  role: z.enum(["supplier", "customer", "transporter"], "Role harus supplier, customer, atau transporter.").optional(),
  q: searchParam,
  limit: limitParam,
});

const ROLE_COLUMN = { supplier: partners.isSupplier, customer: partners.isCustomer, transporter: partners.isTransporter };

/** Lookup of active partners for the staff screens (choosing a supplier, a customer, a transporter). */
export function registerPartnerRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;

  app.get("/api/partners", { preHandler: [guards.authenticate, guards.requireInternal] }, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      eq(partners.isActive, true),
      query.role ? eq(ROLE_COLUMN[query.role], true) : undefined,
      pattern ? or(ilike(partners.name, pattern), ilike(partners.code, pattern)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(partners).where(where);
    const items = await orm
      .select({ id: partners.id, name: partners.name, code: partners.code, isSupplier: partners.isSupplier, isCustomer: partners.isCustomer, isTransporter: partners.isTransporter })
      .from(partners)
      .where(where)
      .orderBy(asc(sql`lower(${partners.name})`), asc(partners.id))
      .limit(query.limit);
    return { items, total: counted?.total ?? 0 };
  });
}
