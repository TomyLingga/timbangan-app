import { and, asc, count, eq, gte, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { erpContracts, partners, products, shipmentRequests } from "../db/schema.js";
import { likeText, limitParam, searchParam, todayAtPlant } from "../http.js";
import { requestedSql } from "../shipment-requests/view.js";

const searchQuery = z.object({
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT.").optional(),
  q: searchParam,
  limit: limitParam,
  includeClosed: z
    .enum(["true", "false"], "includeClosed harus true atau false.")
    .default("false")
    .transform((value) => value === "true"),
  // true: only contracts with a shipment request sent (to the account's company for a partner account: what a
  // supplier may register trucks on; to any supplier for staff); false: only contracts without one
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
    const partner = account.kind === "PARTNER";
    const own = account.partner?.id ?? -1;
    // A partner account is tied to its company here, not through anything the request says: its own contracts, and
    // the contracts INL sent it a request on, whoever their partner is (a mill supplying a trader's contract, 0018).
    // The request joined is the one SENT to its company (at most one open per contract and supplier); staff get none
    // joined and a summary of all requests instead.
    const ownRequest = partner ? and(eq(shipmentRequests.contractId, c.id), eq(shipmentRequests.supplierId, own), eq(shipmentRequests.status, "SENT")) : sql`false`;
    if (partner) conditions.push(or(eq(c.partnerId, own), isNotNull(shipmentRequests.id)));
    if (query.direction) conditions.push(eq(c.direction, query.direction));
    if (query.q) conditions.push(or(ilike(c.contractNo, likeText(query.q)), ilike(partners.name, likeText(query.q))));
    if (!query.includeClosed) {
      conditions.push(eq(c.state, "OPEN"), or(isNull(c.validUntil), gte(c.validUntil, todayAtPlant(context.now()))));
    }
    const anySent = sql`exists (select 1 from shipment_requests s where s.contract_id = ${c.id} and s.status = 'SENT')`;
    if (query.requestSent !== undefined) {
      if (partner) conditions.push(query.requestSent ? isNotNull(shipmentRequests.id) : isNull(shipmentRequests.id));
      else conditions.push(query.requestSent ? anySent : sql`not ${anySent}`);
    }
    const where = and(...conditions);
    const requestCount = (statuses: string) =>
      sql<number>`(select count(*) from shipment_requests s where s.contract_id = ${c.id} and s.status in (${sql.raw(statuses)}))`.mapWith(Number);

    const [counted] = await orm
      .select({ total: count() })
      .from(c)
      .innerJoin(partners, eq(partners.id, c.partnerId))
      .leftJoin(shipmentRequests, ownRequest)
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
        requestQty: shipmentRequests.qtyPlanned,
        openRequests: partner ? sql<number>`0`.mapWith(Number) : requestCount("'DRAFT', 'SENT'"),
        sentRequests: partner ? sql<number>`0`.mapWith(Number) : requestCount("'SENT'"),
        qtyRequested: partner ? sql<number>`0`.mapWith(Number) : requestedSql(c.id),
      })
      .from(c)
      .innerJoin(partners, eq(partners.id, c.partnerId))
      .innerJoin(products, eq(products.id, c.productId))
      .leftJoin(shipmentRequests, ownRequest)
      .where(where)
      // newest contract first: thousands of old purchase contracts stay open in the ERP
      .orderBy(sql`${c.validFrom} desc nulls last`, asc(c.contractNo), asc(c.id))
      .limit(query.limit);

    return {
      items: rows.map(
        ({ partnerId, partnerName, productId, productName, productCategory, requestId, requestStatus, requestSentAt, requestQty, openRequests, sentRequests, qtyRequested, ...contract }) => ({
          ...contract,
          partner: { id: partnerId, name: partnerName },
          product: { id: productId, name: productName, category: productCategory },
          // a partner account: the request sent to its company; staff: null
          shipmentRequest: requestId !== null && requestStatus !== null ? { id: requestId, status: requestStatus, sentAt: requestSentAt, qtyPlanned: requestQty } : null,
          // staff: the requests of the contract to every supplier, and what those not cancelled plan together
          requests: partner ? null : { open: openRequests, sent: sentRequests, qtyRequested },
        }),
      ),
      total: counted?.total ?? 0,
    };
  });
}
