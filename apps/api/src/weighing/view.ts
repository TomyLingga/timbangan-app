// A trip as the weighbridge program and the weighing pages show it: who, what, the figures, the shares.
import { asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Orm } from "../db/client.js";
import { deliveryOrders, drivers, erpContracts, partners, registrationAllocations, registrations, tripAllocations, trips, vehicles, weighings } from "../db/schema.js";

const transporterOf = alias(partners, "weigh_transporter");

export interface WeighTrip {
  id: number;
  tripNo: string | null;
  status: string;
  outcome: string | null;
  direction: "IN" | "OUT";
  flowCode: string;
  currentStep: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  driverName: string | null;
  partner: { id: number; name: string };
  transporter: { id: number; name: string } | null;
  qtyPlanned: number | null;
  docGrossKg: number | null;
  docNetKg: number | null;
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
  allocations: AllocationView[];
}

export interface AllocationView {
  seq: number;
  contractNo: string;
  doNo: string | null;
  uom: string;
  qtyPlanned: number | null;
  originNetKg: number | null;
  netKg: number | null;
  qtyActual: number | null;
  splitMethod: string | null;
}

/** The allocations of a trip with the unit of their contract or DO, in seq order. */
export async function loadAllocations(orm: Orm, tripId: number) {
  return orm
    .select({
      id: tripAllocations.id,
      seq: tripAllocations.seq,
      contractNo: registrationAllocations.contractNo,
      doNo: registrationAllocations.doNo,
      contractId: registrationAllocations.contractId,
      deliveryOrderId: registrationAllocations.deliveryOrderId,
      doQty: deliveryOrders.qty,
      doUom: deliveryOrders.uom,
      contractUom: erpContracts.uom,
      qtyPlanned: tripAllocations.qtyPlanned,
      originNetKg: tripAllocations.originNetKg,
      netKg: tripAllocations.netKg,
      qtyActual: tripAllocations.qtyActual,
      splitMethod: tripAllocations.splitMethod,
    })
    .from(tripAllocations)
    .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
    .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
    .where(eq(tripAllocations.tripId, tripId))
    .orderBy(asc(tripAllocations.seq));
}

export type AllocationRow = Awaited<ReturnType<typeof loadAllocations>>[number];
export const uomOf = (row: AllocationRow) => row.doUom ?? row.contractUom ?? "kg";

export const allocationView = (row: AllocationRow): AllocationView => ({
  seq: row.seq,
  contractNo: row.contractNo,
  doNo: row.doNo,
  uom: uomOf(row),
  qtyPlanned: row.qtyPlanned,
  originNetKg: row.originNetKg,
  netKg: row.netKg,
  qtyActual: row.qtyActual,
  splitMethod: row.splitMethod,
});

export async function loadWeighTrip(orm: Orm, tripId: number): Promise<WeighTrip> {
  const [row] = await orm
    .select({
      trip: trips,
      direction: registrations.direction,
      flowCode: registrations.flowCode,
      partnerId: partners.id,
      partnerName: partners.name,
      transporterId: transporterOf.id,
      transporterName: transporterOf.name,
      vehiclePlate: vehicles.plateNo,
      plateDisplay: vehicles.plateDisplay,
      currentDriver: drivers.fullName,
    })
    .from(trips)
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .innerJoin(partners, eq(partners.id, registrations.partnerId))
    .leftJoin(transporterOf, eq(transporterOf.id, trips.transporterId))
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(eq(trips.id, tripId));
  if (!row) throw new Error(`Trip ${tripId} does not exist.`);
  const { trip } = row;
  return {
    id: trip.id,
    tripNo: trip.tripNo,
    status: trip.status,
    outcome: trip.outcome,
    direction: row.direction,
    flowCode: row.flowCode,
    currentStep: trip.currentStep,
    plateNo: trip.plateNo ?? row.vehiclePlate,
    plateDisplay: row.plateDisplay,
    driverName: trip.driverName ?? row.currentDriver,
    partner: { id: row.partnerId, name: row.partnerName },
    transporter: row.transporterId !== null && row.transporterName !== null ? { id: row.transporterId, name: row.transporterName } : null,
    qtyPlanned: trip.qtyPlanned,
    docGrossKg: trip.docGrossKg,
    docNetKg: trip.docNetKg,
    grossKg: trip.grossKg,
    tareKg: trip.tareKg,
    netKg: trip.netKg,
    allocations: (await loadAllocations(orm, tripId)).map(allocationView),
  };
}

export const weighingView = (row: typeof weighings.$inferSelect) => ({
  id: row.id,
  stage: row.stage,
  kind: row.kind,
  weightKg: row.weightKg,
  weighedAt: row.weighedAt,
  mode: row.mode,
  plateRead: row.plateRead,
  plateCheck: row.plateCheck,
  stationId: row.stationId,
  status: row.status,
});

/** The valid weighings of these trips. */
export async function loadWeighings(orm: Orm, tripIds: number[]) {
  if (tripIds.length === 0) return [];
  return orm.select().from(weighings).where(inArray(weighings.tripId, tripIds)).orderBy(asc(weighings.id));
}
