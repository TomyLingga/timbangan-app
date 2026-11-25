// How a registration is shown.
import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Account } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { deliveryOrders, erpContracts, partners, products, registrationAllocations, registrations, trips, users } from "../db/schema.js";
import { loadTrips } from "../trips/view.js";

const transporterOf = alias(partners, "registration_transporter");
const originOf = alias(partners, "registration_origin");
const allocationPartner = alias(partners, "allocation_partner");
const doContract = alias(erpContracts, "do_contract");

/**
 * What a partner account may see: incoming registrations from its own mill (origin_partner_id) or on its own
 * contracts (partner_id: a trader sees the trucks of every mill supplying its contract), and outgoing registrations
 * it made as the transporter. Staff see every registration.
 */
export function registrationsVisibleTo(account: Account): SQL | undefined {
  if (account.kind !== "PARTNER") return undefined;
  const own = account.partner?.id ?? -1;
  return or(
    and(eq(registrations.direction, "IN"), or(eq(registrations.partnerId, own), eq(registrations.originPartnerId, own))),
    and(eq(registrations.direction, "OUT"), eq(registrations.transporterId, own)),
  );
}

/**
 * What a partner account may change: incoming registrations from its own mill, or written before 0018 (no origin)
 * on its own contract, and outgoing registrations it made as the transporter. A trader reads the trucks of the
 * mills on its contract but does not change them. Staff: every registration (the routes check their levels).
 */
export function registrationsWritableBy(account: Account): SQL | undefined {
  if (account.kind !== "PARTNER") return undefined;
  const own = account.partner?.id ?? -1;
  return or(
    and(eq(registrations.direction, "IN"), or(eq(registrations.originPartnerId, own), and(isNull(registrations.originPartnerId), eq(registrations.partnerId, own)))),
    and(eq(registrations.direction, "OUT"), eq(registrations.transporterId, own)),
  );
}

/** The registrations with these ids, in that order; with their trips unless `withTrips` is false (lists). */
export async function loadRegistrations(orm: Orm, ids: number[], withTrips = true) {
  if (ids.length === 0) return [];
  const rows = await orm
    .select({
      registration: registrations,
      partnerName: partners.name,
      transporterName: transporterOf.name,
      originName: originOf.name,
      creatorName: users.fullName,
    })
    .from(registrations)
    .innerJoin(partners, eq(partners.id, registrations.partnerId))
    .leftJoin(transporterOf, eq(transporterOf.id, registrations.transporterId))
    .leftJoin(originOf, eq(originOf.id, registrations.originPartnerId))
    .innerJoin(users, eq(users.id, registrations.createdBy))
    .where(inArray(registrations.id, ids));
  const allocationRows = await orm
    .select({
      allocation: registrationAllocations,
      contractNo: erpContracts.contractNo,
      doContractId: deliveryOrders.contractId,
      doContractNo: doContract.contractNo,
      productId: products.id,
      productName: products.name,
      productCategory: products.category,
      partnerId: allocationPartner.id,
      partnerName: allocationPartner.name,
    })
    .from(registrationAllocations)
    .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
    .leftJoin(doContract, eq(doContract.id, deliveryOrders.contractId))
    .innerJoin(products, or(eq(products.id, erpContracts.productId), eq(products.id, deliveryOrders.productId)))
    .innerJoin(allocationPartner, or(eq(allocationPartner.id, erpContracts.partnerId), eq(allocationPartner.id, deliveryOrders.partnerId)))
    .where(inArray(registrationAllocations.registrationId, ids))
    .orderBy(asc(registrationAllocations.seq));
  const tripRows = withTrips ? await orm.select({ id: trips.id, registrationId: trips.registrationId }).from(trips).where(inArray(trips.registrationId, ids)).orderBy(asc(trips.seq)) : [];
  const tripViews = await loadTrips(orm, tripRows.map((row) => row.id));

  const views = new Map(
    rows.map(({ registration: r, partnerName, transporterName, originName, creatorName }) => [
      r.id,
      {
        id: r.id,
        regNo: r.regNo,
        direction: r.direction,
        flowCode: r.flowCode,
        status: r.status,
        partner: { id: r.partnerId, name: partnerName },
        transporter: r.transporterId !== null && transporterName !== null ? { id: r.transporterId, name: transporterName } : null,
        // asal PKS (0018)
        originPartner: r.originPartnerId !== null && originName !== null ? { id: r.originPartnerId, name: originName } : null,
        plannedDate: r.plannedDate,
        truckCount: r.truckCount,
        qtyTotal: r.qtyTotal,
        uom: r.uom,
        closeCargo: r.closeCargo,
        flexiBag: r.flexiBag,
        remark: r.remark,
        createdVia: r.createdVia,
        createdBy: { id: r.createdBy, fullName: creatorName },
        createdAt: r.createdAt,
        submittedAt: r.submittedAt,
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        findings: r.checkFindings,
        allocations: allocationRows
          .filter((row) => row.allocation.registrationId === r.id)
          .map(({ allocation: a, ...row }) => ({
            seq: a.seq,
            contract:
              a.contractId !== null
                ? { id: a.contractId, contractNo: row.contractNo ?? a.contractNo }
                : row.doContractId !== null
                  ? { id: row.doContractId, contractNo: row.doContractNo ?? a.contractNo }
                  : null,
            deliveryOrder: a.deliveryOrderId !== null ? { id: a.deliveryOrderId, doNo: a.doNo } : null,
            contractNo: a.contractNo,
            doNo: a.doNo,
            qtyPlanned: a.qtyPlanned,
            tolerancePct: a.tolerancePct,
            product: { id: row.productId, name: row.productName, category: row.productCategory },
            partner: { id: row.partnerId, name: row.partnerName },
          })),
        ...(withTrips ? { trips: tripViews.filter((trip) => trip.registrationId === r.id) } : {}),
      },
    ]),
  );
  return ids.map((id) => views.get(id)).filter((view) => view !== undefined);
}
