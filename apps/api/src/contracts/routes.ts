import { and, asc, count, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { erpContracts, partners, products, shipmentRequests } from "../db/schema.js";
import { likeText, limitParam, searchParam, todayAtPlant } from "../http.js";

const searchQuery = z.object({
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT.").optional(),
  q: searchParam,
  limit: limitParam,
  includeClosed: z
    .enum(["true", "false"], "includeClosed harus true atau false.")
    .default("false")
    .transform((value) => value === "true"),
  // true: only contracts with a shipment request sent to the supplier (what a supplier may register trucks on);
  // false: only contracts without one
  requestSent: z
    .enum(["true", "false"], "requestSent harus true atau false.")
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});

export function registerContractRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const c = erpContracts;

  app.get("/api/contracts", { preHandler: [guards.authenticate, guards.requirePermission("contracts", "VIEW")] }, async (request) => {
    const query = searchQuery.parse(request.query);
    const account = accountOf(request);

    const conditions: (SQL | undefined)[] = [];
    // A partner account is tied to its company here, not through anything the request says.
    if (account.kind === "PARTNER") conditions.push(eq(c.partnerId, account.partner?.id ?? -1));
    if (query.direction) conditions.push(eq(c.direction, query.direction));
    if (query.q) conditions.push(or(ilike(c.contractNo, likeText(query.q)), ilike(partners.name, likeText(query.q))));
    if (!query.includeClosed) {
      conditions.push(eq(c.state, "OPEN"), or(isNull(c.validUntil), gte(c.validUntil, todayAtPlant(context.now()))));
    }
    if (query.requestSent !== undefined) conditions.push(query.requestSent ? eq(shipmentRequests.status, "SENT") : sql`${shipmentRequests.status} is distinct from 'SENT'`);
    const where = and(...conditions);
    // the open request of the contract (at most one, see 0017); a partner account sees it only once it was sent
    const openRequest = and(
      eq(shipmentRequests.contractId, c.id),
      account.kind === "PARTNER" ? eq(shipmentRequests.status, "SENT") : inArray(shipmentRequests.status, ["DRAFT", "SENT"]),
    );

    const [counted] = await orm
      .select({ total: count() })
      .from(c)
      .innerJoin(partners, eq(partners.id, c.partnerId))
      .leftJoin(shipmentRequests, openRequest)
      .where(where);
    const rows = await orm
      .select({
        id: c.id,
        contractNo: c.contractNo,
        direction: c.direction,
        partnerId: partners.id,
        partnerName: partners.name,
        productId: products.id,
        productName: products.name,
        productCategory: products.category,
        qtyContract: c.qtyContract,
        uom: c.uom,
        tolerancePct: c.tolerancePct,
        certificate: c.certificate,
        validFrom: c.validFrom,
        validUntil: c.validUntil,
        customerPoNo: c.customerPoNo,
        state: c.state,
        syncedAt: c.syncedAt,
        requestId: shipmentRequests.id,
        requestStatus: shipmentRequests.status,
        requestSentAt: shipmentRequests.sentAt,
      })
      .from(c)
      .innerJoin(partners, eq(partners.id, c.partnerId))
      .innerJoin(products, eq(products.id, c.productId))
      .leftJoin(shipmentRequests, openRequest)
      .where(where)
      // newest contract first: thousands of old purchase contracts stay open in the ERP
      .orderBy(sql`${c.validFrom} desc nulls last`, asc(c.contractNo), asc(c.id))
      .limit(query.limit);

    return {
      items: rows.map(({ partnerId, partnerName, productId, productName, productCategory, requestId, requestStatus, requestSentAt, ...contract }) => ({
        ...contract,
        partner: { id: partnerId, name: partnerName },
        product: { id: productId, name: productName, category: productCategory },
        shipmentRequest: requestId !== null && requestStatus !== null ? { id: requestId, status: requestStatus, sentAt: requestSentAt } : null,
      })),
      total: counted?.total ?? 0,
    };
  });
}
