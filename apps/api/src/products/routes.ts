import { and, asc, count, eq, ilike, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { products, qualityParameters } from "../db/schema.js";
import { likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({ q: searchParam, limit: limitParam });

/** Master data the registration and DO forms choose from: quality parameters and products. */
export function registerProductRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;

  app.get("/api/quality-parameters", { preHandler: [guards.authenticate, guards.requirePermission("registrations", "VIEW")] }, async () => {
    const items = await orm
      .select({
        code: qualityParameters.code,
        name: qualityParameters.name,
        unit: qualityParameters.unit,
        decimals: qualityParameters.decimals,
        minValid: qualityParameters.minValid,
        maxValid: qualityParameters.maxValid,
      })
      .from(qualityParameters)
      .where(eq(qualityParameters.isActive, true))
      .orderBy(asc(qualityParameters.sortOrder), asc(qualityParameters.code));
    return { items };
  });

  // staff only: a partner account gets its products through its contracts and DOs
  app.get("/api/products", { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("delivery_orders", "VIEW")] }, async (request) => {
    const query = listQuery.parse(request.query);
    const where = and(eq(products.isActive, true), query.q ? ilike(products.name, likeText(query.q)) : undefined);
    const [counted] = await orm.select({ total: count() }).from(products).where(where);
    const items = await orm
      .select({ id: products.id, name: products.name, category: products.category })
      .from(products)
      .where(where)
      .orderBy(asc(sql`lower(${products.name})`), asc(products.id))
      .limit(query.limit);
    return { items, total: counted?.total ?? 0 };
  });
}
