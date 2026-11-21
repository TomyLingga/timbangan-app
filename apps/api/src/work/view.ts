// The work list as the phones show it: a waiting step with its truck, what the form of a step needs, and the
// results of the steps a truck went through, in short.
import { and, asc, desc, eq, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Account, can } from "../auth/guard.js";
import type { ModuleCode } from "../auth/permissions.js";
import type { Orm } from "../db/client.js";
import { productsByIds, tankTakes } from "../plant-masters/tank-products.js";
import {
  deliveryOrders,
  drivers,
  erpContracts,
  flowSteps,
  handlings,
  inspections,
  partners,
  productQualitySpecs,
  products,
  qualityChecks,
  qualityParameters,
  qualityValues,
  registrationAllocations,
  registrations,
  storageTanks,
  tripAllocations,
  trips,
  tripSeals,
  tripSteps,
  vehicles,
  weighings,
} from "../db/schema.js";
import { todayAtPlant } from "../http.js";
import { loadTrips } from "../trips/view.js";

/** Step statuses that put a step on the work list. */
export const WAITING = ["READY", "IN_PROGRESS"] as const;

const transporterOf = alias(partners, "work_transporter");

/** The modules the account may view, which are the modules whose steps it sees. */
export const viewableModules = (account: Account) => Object.keys(account.permissions).filter((code) => can(account, code as ModuleCode, "VIEW"));

export interface WorkTruck {
  tripId: number;
  tripNo: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  direction: "IN" | "OUT";
  flowCode: string;
  product: { id: number; name: string } | null;
  partner: { id: number; name: string };
  transporter: { id: number; name: string } | null;
  driverName: string | null;
}

export interface WorkRow {
  id: number;
  stepCode: string;
  name: string;
  module: string | null;
  status: string;
  result: string | null;
  attempt: number;
  readyAt: Date | null;
  startedAt: Date | null;
  truck: WorkTruck;
}

/** The products of these trips, in allocation order. */
export async function tripProducts(orm: Orm, tripIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
  const found = new Map<number, { id: number; name: string }[]>();
  if (tripIds.length === 0) return found;
  const rows = await orm
    .select({ tripId: tripAllocations.tripId, id: products.id, name: products.name })
    .from(tripAllocations)
    .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
    .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
    .innerJoin(products, or(eq(products.id, erpContracts.productId), eq(products.id, deliveryOrders.productId)))
    .where(inArray(tripAllocations.tripId, tripIds))
    .orderBy(asc(tripAllocations.tripId), asc(tripAllocations.seq));
  for (const row of rows) {
    const list = found.get(row.tripId) ?? [];
    if (!list.some((item) => item.id === row.id)) list.push({ id: row.id, name: row.name });
    found.set(row.tripId, list);
  }
  return found;
}

/** Steps with their truck, oldest ready first. `where` narrows trip_steps, trips, registrations or flow_steps. */
export async function loadWorkRows(orm: Orm, where: SQL | undefined, limit: number): Promise<WorkRow[]> {
  const rows = await orm
    .select({
      step: tripSteps,
      name: flowSteps.name,
      module: flowSteps.performerModule,
      trip: { id: trips.id, tripNo: trips.tripNo, plateNo: trips.plateNo, driverName: trips.driverName },
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
    .from(tripSteps)
    .innerJoin(trips, eq(trips.id, tripSteps.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .innerJoin(flowSteps, and(eq(flowSteps.siteId, trips.siteId), eq(flowSteps.flowCode, registrations.flowCode), eq(flowSteps.stepCode, tripSteps.stepCode)))
    .innerJoin(partners, eq(partners.id, registrations.partnerId))
    .leftJoin(transporterOf, eq(transporterOf.id, trips.transporterId))
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(where)
    .orderBy(asc(tripSteps.readyAt), asc(tripSteps.id))
    .limit(limit);
  const productsOf = await tripProducts(orm, [...new Set(rows.map((row) => row.trip.id))]);
  return rows.map((row) => ({
    id: row.step.id,
    stepCode: row.step.stepCode,
    name: row.name,
    module: row.module,
    status: row.step.status,
    result: row.step.result,
    attempt: row.step.attempt,
    readyAt: row.step.readyAt,
    startedAt: row.step.startedAt,
    truck: {
      tripId: row.trip.id,
      tripNo: row.trip.tripNo,
      plateNo: row.trip.plateNo ?? row.vehiclePlate,
      plateDisplay: row.plateDisplay,
      direction: row.direction,
      flowCode: row.flowCode,
      product: productsOf.get(row.trip.id)?.[0] ?? null,
      partner: { id: row.partnerId, name: row.partnerName },
      transporter: row.transporterId !== null && row.transporterName !== null ? { id: row.transporterId, name: row.transporterName } : null,
      driverName: row.trip.driverName ?? row.currentDriver,
    },
  }));
}

/** The quality figures each form asks for; the others of the parameter table are not on that form. */
export function formParameters(flowCode: string, stepCode: string): { code: string; required: boolean }[] {
  if (stepCode === "QC" && flowCode === "IN_CPO") {
    return [
      { code: "FFA", required: true },
      { code: "MOISTURE", required: true },
      { code: "IMPURITIES", required: false },
    ];
  }
  if (stepCode === "QC_LOADING") {
    return ["FFA", "MOISTURE", "IMPURITIES", "MNI", "IV", "LOVIBOND", "MELTING_POINT", "CLOUD_POINT", "SAPONIFIABLE", "PEROXIDE", "SMOKE_POINT"].map((code) => ({ code, required: code === "FFA" }));
  }
  return [];
}

/** Steps whose form chooses a storage tank. */
const TANK_STEPS = ["UNLOADING", "QC_LOADING"];

export interface FormParameter {
  code: string;
  name: string;
  unit: string;
  decimals: number;
  minValid: number;
  maxValid: number;
  required: boolean;
  spec: { min: number | null; max: number | null } | null;
}

/** The parameters of a form with their entry range and the product's spec limits valid on the plant date. */
export async function loadFormParameters(orm: Orm, flowCode: string, stepCode: string, productId: number | null, now: Date): Promise<FormParameter[]> {
  const wanted = formParameters(flowCode, stepCode);
  if (wanted.length === 0) return [];
  const rows = await orm.select().from(qualityParameters).where(inArray(qualityParameters.code, wanted.map((item) => item.code)));
  const specs =
    productId === null
      ? []
      : await orm
          .select()
          .from(productQualitySpecs)
          .where(and(eq(productQualitySpecs.productId, productId), lte(productQualitySpecs.validFrom, todayAtPlant(now))))
          .orderBy(desc(productQualitySpecs.validFrom));
  return wanted.flatMap(({ code, required }) => {
    const row = rows.find((item) => item.code === code);
    // a parameter that is switched off is not on the form
    if (!row || !row.isActive) return [];
    const spec = specs.find((item) => item.parameterCode === code);
    return [{
      code,
      name: row.name,
      unit: row.unit,
      decimals: row.decimals,
      minValid: row.minValid,
      maxValid: row.maxValid,
      required,
      spec: spec ? { min: spec.minValue, max: spec.maxValue } : null,
    }];
  });
}

/**
 * Active tanks of the site that may take one of these products: a tank of one of them, a tank whose Odoo label
 * names one of them, and a tank without product and label (it takes any).
 */
export async function tankChoices(orm: Orm, siteId: number, productIds: number[]) {
  const rows = await orm
    .select({ id: storageTanks.id, code: storageTanks.code, name: storageTanks.name, productId: storageTanks.productId, productLabel: storageTanks.productLabel })
    .from(storageTanks)
    .where(
      and(
        eq(storageTanks.siteId, siteId),
        eq(storageTanks.isActive, true),
        productIds.length ? or(isNull(storageTanks.productId), inArray(storageTanks.productId, productIds)) : isNull(storageTanks.productId),
      ),
    )
    .orderBy(asc(storageTanks.code));
  const truckProducts = await productsByIds(orm, productIds);
  return rows.filter((tank) => tankTakes(tank, truckProducts)).map(({ id, code, name }) => ({ id, code, name }));
}

/** Applied seals of the trip that are still on the truck. */
export async function sealsInPlace(orm: Orm, tripId: number) {
  return orm
    .select({ id: tripSeals.id, sealId: tripSeals.sealId, sealNo: tripSeals.sealNo, kind: tripSeals.kind, position: tripSeals.position, appliedAt: tripSeals.appliedAt })
    .from(tripSeals)
    .where(and(eq(tripSeals.tripId, tripId), eq(tripSeals.origin, "APPLIED"), isNull(tripSeals.removedAt)))
    .orderBy(asc(tripSeals.id));
}

/** Every step the truck finished (done or failed), every attempt, with the gist of what was recorded. */
export async function loadHistory(orm: Orm, tripId: number) {
  const steps = await orm
    .select({ step: tripSteps, name: flowSteps.name })
    .from(tripSteps)
    .innerJoin(trips, eq(trips.id, tripSteps.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .leftJoin(flowSteps, and(eq(flowSteps.siteId, trips.siteId), eq(flowSteps.flowCode, registrations.flowCode), eq(flowSteps.stepCode, tripSteps.stepCode)))
    .where(and(eq(tripSteps.tripId, tripId), inArray(tripSteps.status, ["DONE", "FAILED"])))
    .orderBy(asc(tripSteps.finishedAt), asc(tripSteps.seq), asc(tripSteps.attempt));
  const weighed = await orm.select().from(weighings).where(and(eq(weighings.tripId, tripId), eq(weighings.status, "VALID")));
  const checked = await orm.select().from(inspections).where(eq(inspections.tripId, tripId));
  const sampled = await orm.select().from(qualityChecks).where(eq(qualityChecks.tripId, tripId));
  const values = sampled.length
    ? await orm.select().from(qualityValues).where(inArray(qualityValues.qualityCheckId, sampled.map((row) => row.id)))
    : [];
  const handled = await orm
    .select({ handling: handlings, tankCode: storageTanks.code })
    .from(handlings)
    .leftJoin(storageTanks, eq(storageTanks.id, handlings.tankId))
    .where(eq(handlings.tripId, tripId));
  const sealed = await orm.select().from(tripSeals).where(eq(tripSeals.tripId, tripId));
  const valuesOf = (checkId: number) => Object.fromEntries(values.filter((value) => value.qualityCheckId === checkId).map((value) => [value.parameterCode, value.value]));

  const summaryOf = (step: typeof tripSteps.$inferSelect): Record<string, unknown> | null => {
    const weighing = weighed.find((row) => row.tripStepId === step.id);
    if (weighing) return { weightKg: weighing.weightKg, kind: weighing.kind };
    const inspection = checked.find((row) => row.tripStepId === step.id);
    if (inspection) return { result: inspection.result, remark: inspection.remark };
    const quality = sampled.find((row) => row.tripStepId === step.id);
    if (quality) {
      const tank = handled.find((row) => row.handling.tankId === quality.tankId)?.tankCode ?? null;
      return quality.stage === "RECEIVING"
        ? { disposition: quality.disposition, reasonCode: quality.reasonCode, decision: quality.decision, values: valuesOf(quality.id) }
        : { certificateNo: quality.certificateNo, tank, values: valuesOf(quality.id) };
    }
    const handling = handled.filter((row) => row.handling.tripStepId === step.id);
    if (handling.length) {
      const first = handling[0]?.handling;
      return {
        tanks: handling.map((row) => row.tankCode).filter((code) => code !== null),
        startedAt: first?.startedAt ?? null,
        finishedAt: first?.finishedAt ?? null,
        temperatureC: first?.temperatureC ?? null,
      };
    }
    const seals = sealed.filter((row) => row.tripStepId === step.id);
    if (seals.length) return { seals: seals.map((row) => row.sealNo) };
    return null;
  };

  return steps.map(({ step, name }) => ({
    stepCode: step.stepCode,
    name: name ?? step.stepCode,
    attempt: step.attempt,
    status: step.status,
    result: step.result,
    finishedAt: step.finishedAt,
    note: step.note,
    summary: summaryOf(step),
  }));
}

/** What the form of this step needs besides the truck. */
export async function loadFormData(orm: Orm, row: WorkRow, siteId: number, now: Date) {
  const { truck } = row;
  const productIds = (await tripProducts(orm, [truck.tripId])).get(truck.tripId)?.map((item) => item.id) ?? [];
  const [view] = truck.direction === "IN" ? await loadTrips(orm, [truck.tripId]) : [];
  const declaredSeals = await orm
    .select({ id: tripSeals.id, sealNo: tripSeals.sealNo, kind: tripSeals.kind })
    .from(tripSeals)
    .where(and(eq(tripSeals.tripId, truck.tripId), eq(tripSeals.origin, "DECLARED")))
    .orderBy(asc(tripSeals.id));
  return {
    letter: view ? { docGrossKg: view.docGrossKg, docTareKg: view.docTareKg, docNetKg: view.docNetKg, allocations: view.allocations } : null,
    declaredSeals,
    tanks: TANK_STEPS.includes(row.stepCode) ? await tankChoices(orm, siteId, productIds) : [],
    parameters: await loadFormParameters(orm, truck.flowCode, row.stepCode, productIds[0] ?? null, now),
    sealsInPlace: await sealsInPlace(orm, truck.tripId),
    history: await loadHistory(orm, truck.tripId),
  };
}
