// How a shipment request is shown, who may see it, and the check a supplier's registration needs. Kept apart from
// the routes so the file and registration code can use them without importing the routes.
import { type AnyColumn, and, desc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Account } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { erpContracts, partners, products, shipmentRequests, users } from "../db/schema.js";

/** The statuses a supplier account sees: the request was sent to it. */
export const PARTNER_STATUSES = ["SENT", "CLOSED"] as const;

/**
 * What a partner account may see: requests sent to its own company as the supplier (SENT or CLOSED), whoever the
 * partner of the contract is (0018). Staff see every request.
 */
export const shipmentRequestsVisibleTo = (account: Account): SQL | undefined =>
  account.kind === "PARTNER" ? and(eq(shipmentRequests.supplierId, account.partner?.id ?? -1), inArray(shipmentRequests.status, [...PARTNER_STATUSES])) : undefined;

/** Whether the contract has a request sent to this supplier and not yet closed or cancelled. */
export async function hasSentRequest(orm: Orm, contractId: number, supplierId: number): Promise<boolean> {
  const [row] = await orm
    .select({ id: shipmentRequests.id })
    .from(shipmentRequests)
    .where(and(eq(shipmentRequests.contractId, contractId), eq(shipmentRequests.supplierId, supplierId), eq(shipmentRequests.status, "SENT")))
    .limit(1);
  return row !== undefined;
}

/** Whether a request on the contract was ever shown to this supplier (SENT or CLOSED). */
export async function hasShownRequest(orm: Orm, contractId: number, supplierId: number): Promise<boolean> {
  const [row] = await orm
    .select({ id: shipmentRequests.id })
    .from(shipmentRequests)
    .where(and(eq(shipmentRequests.contractId, contractId), eq(shipmentRequests.supplierId, supplierId), inArray(shipmentRequests.status, [...PARTNER_STATUSES])))
    .limit(1);
  return row !== undefined;
}

/**
 * The quantity the requests of a contract plan together: every request that is not cancelled, a request without a
 * quantity counting as 0. `except` leaves out the request being changed.
 */
export async function requestedOnContract(orm: Orm, contractId: number, except: number | null): Promise<number> {
  const [row] = await orm
    .select({ total: sql<number>`coalesce(sum(${shipmentRequests.qtyPlanned}), 0)`.mapWith(Number) })
    .from(shipmentRequests)
    .where(and(eq(shipmentRequests.contractId, contractId), ne(shipmentRequests.status, "CANCELLED"), except === null ? undefined : ne(shipmentRequests.id, except)));
  return row?.total ?? 0;
}

/** The same sum inside a query, per contract row. */
export const requestedSql = (contractId: SQL | AnyColumn) =>
  sql<number>`(select coalesce(sum(r.qty_planned), 0) from shipment_requests r where r.contract_id = ${contractId} and r.status <> 'CANCELLED')`.mapWith(Number);

const createdBy = alias(users, "request_created_by");
const sentBy = alias(users, "request_sent_by");
const closedBy = alias(users, "request_closed_by");
const cancelledBy = alias(users, "request_cancelled_by");
const supplierOf = alias(partners, "request_supplier");

const fileCountSql = sql<number>`(select count(*) from shipment_request_files f where f.shipment_request_id = ${shipmentRequests.id})`.mapWith(Number);

const person = (id: number | null, fullName: string | null) => (id !== null && fullName !== null ? { id, fullName } : null);

/**
 * The requests matching `where`, newest first. `showRequested` adds what all requests of the contract plan together
 * (contract.qtyRequested); a supplier account is not told what the other mills were asked for.
 */
export async function listShipmentRequests(orm: Orm, where: SQL | undefined, limit: number, showRequested = true) {
  const rows = await orm
    .select({
      request: shipmentRequests,
      contract: {
        state: erpContracts.state,
        qtyContract: erpContracts.qtyContract,
        uom: erpContracts.uom,
        tolerancePct: erpContracts.tolerancePct,
        validFrom: erpContracts.validFrom,
        validUntil: erpContracts.validUntil,
      },
      productId: products.id,
      productName: products.name,
      productCategory: products.category,
      partnerName: partners.name,
      supplierName: supplierOf.name,
      qtyRequested: requestedSql(shipmentRequests.contractId),
      createdByName: createdBy.fullName,
      sentByName: sentBy.fullName,
      closedByName: closedBy.fullName,
      cancelledByName: cancelledBy.fullName,
      fileCount: fileCountSql,
    })
    .from(shipmentRequests)
    .innerJoin(erpContracts, eq(erpContracts.id, shipmentRequests.contractId))
    .innerJoin(products, eq(products.id, erpContracts.productId))
    .innerJoin(partners, eq(partners.id, shipmentRequests.partnerId))
    .innerJoin(supplierOf, eq(supplierOf.id, shipmentRequests.supplierId))
    .innerJoin(createdBy, eq(createdBy.id, shipmentRequests.createdBy))
    .leftJoin(sentBy, eq(sentBy.id, shipmentRequests.sentBy))
    .leftJoin(closedBy, eq(closedBy.id, shipmentRequests.closedBy))
    .leftJoin(cancelledBy, eq(cancelledBy.id, shipmentRequests.cancelledBy))
    .where(where)
    .orderBy(desc(shipmentRequests.createdAt), desc(shipmentRequests.id))
    .limit(limit);
  return rows.map(({ request: r, contract, ...row }) => ({
    id: r.id,
    status: r.status,
    contract: {
      id: r.contractId,
      contractNo: r.contractNo,
      state: contract.state,
      qtyContract: contract.qtyContract,
      uom: contract.uom,
      tolerancePct: contract.tolerancePct,
      validFrom: contract.validFrom,
      validUntil: contract.validUntil,
      qtyRequested: showRequested ? row.qtyRequested : null,
    },
    product: { id: row.productId, name: row.productName, category: row.productCategory },
    // the partner of the contract (a trader or the mill itself) and the mill the request goes to
    partner: { id: r.partnerId, name: row.partnerName },
    supplier: { id: r.supplierId, name: row.supplierName },
    qtyPlanned: r.qtyPlanned,
    uom: contract.uom,
    deliveryFrom: r.deliveryFrom,
    deliveryUntil: r.deliveryUntil,
    remark: r.remark,
    fileCount: row.fileCount,
    createdBy: { id: r.createdBy, fullName: row.createdByName },
    createdAt: r.createdAt,
    sentBy: person(r.sentBy, row.sentByName),
    sentAt: r.sentAt,
    closedBy: person(r.closedBy, row.closedByName),
    closedAt: r.closedAt,
    cancelledBy: person(r.cancelledBy, row.cancelledByName),
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    updatedAt: r.updatedAt,
  }));
}
