// How a trip is shown, and the trip statuses the rules group together.
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Orm } from "../db/client.js";
import {
  cardAssignments,
  drivers,
  partners,
  qualityValues,
  registrations,
  rfidCards,
  spjDocuments,
  tripAllocations,
  trips,
  type TripStatus,
  vehicles,
} from "../db/schema.js";

/** Trips that no longer hold quantity of a contract or a DO. */
export const RELEASED_STATUSES: TripStatus[] = ["CANCELLED", "EXPIRED", "REJECTED"];
/** A truck inside the plant. */
export const INSIDE_STATUSES: TripStatus[] = ["CHECKED_IN", "IN_PROCESS"];
/** A truck that has checked in, whatever happened after. */
export const ARRIVED_STATUSES: TripStatus[] = ["CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED"];

const transporterOf = alias(partners, "trip_transporter");

export interface TripView {
  id: number;
  registrationId: number;
  seq: number;
  tripNo: string | null;
  status: TripStatus;
  direction: "IN" | "OUT";
  flowCode: string;
  partner: { id: number; name: string };
  transporter: { id: number; name: string } | null;
  currentStep: string | null;
  vehicle: { id: number; plateNo: string; plateDisplay: string; vehicleTypeCode: string } | null;
  driver: { id: number; fullName: string; licenceNo: string; registryStatus: string } | null;
  containerNo: string | null;
  plannedArrival: string | null;
  qtyPlanned: number | null;
  docGrossKg: number | null;
  docTareKg: number | null;
  docNetKg: number | null;
  allocations: {
    seq: number;
    qtyPlanned: number | null;
    handoverNo: string | null;
    spbNo: string | null;
    spbDate: string | null;
    originTicketNo: string | null;
    originGrossKg: number | null;
    originTareKg: number | null;
    originNetKg: number | null;
    quality: Record<string, number>;
  }[];
  spj: { id: number; spjNo: string; barcodeToken: string; issuedAt: Date; validUntil: Date | null; printCount: number } | null;
  card: { uid: string; label: string | null } | null;
  checkedInAt: Date | null;
  cancelReason: string | null;
}

/** The trips with these ids, in the order of the ids. */
export async function loadTrips(orm: Orm, ids: number[]): Promise<TripView[]> {
  if (ids.length === 0) return [];
  const rows = await orm
    .select({
      trip: trips,
      direction: registrations.direction,
      flowCode: registrations.flowCode,
      partnerId: partners.id,
      partnerName: partners.name,
      transporterId: transporterOf.id,
      transporterName: transporterOf.name,
      vehicleId: vehicles.id,
      plateNo: vehicles.plateNo,
      plateDisplay: vehicles.plateDisplay,
      vehicleTypeCode: vehicles.vehicleTypeCode,
      driverId: drivers.id,
      fullName: drivers.fullName,
      licenceNo: drivers.licenceNo,
      registryStatus: drivers.registryStatus,
    })
    .from(trips)
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .innerJoin(partners, eq(partners.id, registrations.partnerId))
    .leftJoin(transporterOf, eq(transporterOf.id, trips.transporterId))
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(inArray(trips.id, ids));

  const allocationRows = await orm.select().from(tripAllocations).where(inArray(tripAllocations.tripId, ids)).orderBy(asc(tripAllocations.seq));
  const quality = allocationRows.length
    ? await orm
        .select({ tripAllocationId: qualityValues.tripAllocationId, code: qualityValues.parameterCode, value: qualityValues.value })
        .from(qualityValues)
        .where(inArray(qualityValues.tripAllocationId, allocationRows.map((row) => row.id)))
    : [];
  const spjRows = await orm.select().from(spjDocuments).where(and(inArray(spjDocuments.tripId, ids), isNull(spjDocuments.revokedAt)));
  const cards = await orm
    .select({ tripId: cardAssignments.tripId, uid: rfidCards.uid, label: rfidCards.label })
    .from(cardAssignments)
    .innerJoin(rfidCards, eq(rfidCards.id, cardAssignments.cardId))
    .where(and(inArray(cardAssignments.tripId, ids), isNull(cardAssignments.releasedAt)));

  const views = new Map<number, TripView>();
  for (const row of rows) {
    const { trip } = row;
    const spj = spjRows.find((item) => item.tripId === trip.id);
    const card = cards.find((item) => item.tripId === trip.id);
    views.set(trip.id, {
      id: trip.id,
      registrationId: trip.registrationId,
      seq: trip.seq,
      tripNo: trip.tripNo,
      status: trip.status,
      direction: row.direction,
      flowCode: row.flowCode,
      partner: { id: row.partnerId, name: row.partnerName },
      transporter: row.transporterId !== null && row.transporterName !== null ? { id: row.transporterId, name: row.transporterName } : null,
      currentStep: trip.currentStep,
      vehicle:
        row.vehicleId !== null && row.plateNo !== null && row.plateDisplay !== null && row.vehicleTypeCode !== null
          ? { id: row.vehicleId, plateNo: row.plateNo, plateDisplay: row.plateDisplay, vehicleTypeCode: row.vehicleTypeCode }
          : null,
      driver:
        row.driverId !== null && row.fullName !== null && row.licenceNo !== null && row.registryStatus !== null
          ? { id: row.driverId, fullName: row.fullName, licenceNo: row.licenceNo, registryStatus: row.registryStatus }
          : null,
      containerNo: trip.containerNo,
      plannedArrival: trip.plannedArrival,
      qtyPlanned: trip.qtyPlanned,
      docGrossKg: trip.docGrossKg,
      docTareKg: trip.docTareKg,
      docNetKg: trip.docNetKg,
      allocations: allocationRows
        .filter((allocation) => allocation.tripId === trip.id)
        .map((allocation) => ({
          seq: allocation.seq,
          qtyPlanned: allocation.qtyPlanned,
          handoverNo: allocation.handoverNo,
          spbNo: allocation.spbNo,
          spbDate: allocation.spbDate,
          originTicketNo: allocation.originTicketNo,
          originGrossKg: allocation.originGrossKg,
          originTareKg: allocation.originTareKg,
          originNetKg: allocation.originNetKg,
          quality: Object.fromEntries(quality.filter((value) => value.tripAllocationId === allocation.id).map((value) => [value.code, value.value])),
        })),
      spj: spj ? { id: spj.id, spjNo: spj.spjNo, barcodeToken: spj.barcodeToken, issuedAt: spj.issuedAt, validUntil: spj.validUntil, printCount: spj.printCount } : null,
      card: card ? { uid: card.uid, label: card.label } : null,
      checkedInAt: trip.checkedInAt,
      cancelReason: trip.cancelReason,
    });
  }
  return ids.map((id) => views.get(id)).filter((view): view is TripView => view !== undefined);
}

/**
 * Lazy expiry: an ISSUED trip whose active SPJ is past its validity becomes EXPIRED. Called where trips are
 * read (lists, scan, check-in), so no scheduler is needed.
 */
export async function expireDueTrips(orm: Orm, now: Date): Promise<void> {
  await orm
    .update(trips)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      and(
        eq(trips.status, "ISSUED"),
        inArray(
          trips.id,
          orm.select({ id: spjDocuments.tripId }).from(spjDocuments).where(and(isNull(spjDocuments.revokedAt), lt(spjDocuments.validUntil, now))),
        ),
      ),
    );
}

