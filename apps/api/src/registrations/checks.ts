// The checks of a stored registration: hard refusals (thrown, nothing is saved) and findings (stored, and a
// reason for a logistics admin to review the registration).
import { and, eq, inArray, isNull, ne, notInArray, or, gt } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import {
  deliveryOrders,
  driverBlocks,
  drivers,
  erpContracts,
  type Finding,
  registrationAllocations,
  registrations,
  tripAllocations,
  trips,
  vehicles,
} from "../db/schema.js";
import { refused } from "../errors.js";
import { todayAtPlant } from "../http.js";
import { readSetting } from "../settings.js";
import { RELEASED_STATUSES } from "../trips/view.js";

type RegistryStatus = "UNKNOWN" | "NORMAL" | "WARNING" | "BLACKLIST";
type Policy = "BLOCK" | "WARN" | "ALLOW";
const DEFAULT_POLICY: Record<RegistryStatus, Policy> = { BLACKLIST: "BLOCK", WARNING: "WARN", UNKNOWN: "ALLOW", NORMAL: "ALLOW" };

/** The code a registry status gives, whether the policy makes it a refusal or a finding. */
const REGISTRY_CODES: Record<RegistryStatus, string | null> = {
  BLACKLIST: "DRIVER_BLACKLISTED",
  WARNING: "DRIVER_WARNING",
  UNKNOWN: "DRIVER_NOT_IN_REGISTRY",
  NORMAL: null,
};
const REGISTRY_MESSAGES: Record<RegistryStatus, string> = {
  BLACKLIST: "masuk daftar hitam VCF",
  WARNING: "berstatus peringatan di VCF",
  UNKNOWN: "belum terdaftar di VCF",
  NORMAL: "",
};

export async function driverPolicy(orm: Orm, siteId: number): Promise<Record<RegistryStatus, Policy>> {
  const setting = (await readSetting<Partial<Record<RegistryStatus, Policy>>>(orm, siteId, "driver_registry_policy")) ?? {};
  return { ...DEFAULT_POLICY, ...setting };
}

/** What the registry status of a driver means under the policy: a refusal, a finding, or nothing. */
export function registryVerdict(policy: Record<RegistryStatus, Policy>, status: RegistryStatus, name: string) {
  const code = REGISTRY_CODES[status];
  const action = policy[status] ?? "ALLOW";
  if (!code || action === "ALLOW") return null;
  return { code, level: action === "BLOCK" ? ("BLOCK" as const) : ("WARN" as const), message: `Supir ${name} ${REGISTRY_MESSAGES[status]}.` };
}

/** Whether a local block of the driver is in force at `now`. */
export async function isDriverBlocked(orm: Orm, driverId: number, now: Date): Promise<boolean> {
  const [block] = await orm
    .select({ id: driverBlocks.id })
    .from(driverBlocks)
    .where(and(eq(driverBlocks.driverId, driverId), isNull(driverBlocks.liftedAt), or(isNull(driverBlocks.blockedUntil), gt(driverBlocks.blockedUntil, now))))
    .limit(1);
  return block !== undefined;
}

/** Papers of a vehicle that are past today, as findings without a trip number. */
export function vehicleFindings(vehicle: { plateDisplay: string; verifiedAt: Date | null; stnkValidUntil: string | null; taxValidUntil: string | null; kirValidUntil: string | null }, today: string) {
  const found: { code: string; message: string }[] = [];
  if (vehicle.verifiedAt === null) found.push({ code: "VEHICLE_UNVERIFIED", message: `Kendaraan ${vehicle.plateDisplay} belum diverifikasi logistik.` });
  const papers = [
    ["STNK_EXPIRED", "STNK", vehicle.stnkValidUntil],
    ["TAX_EXPIRED", "Pajak", vehicle.taxValidUntil],
    ["KIR_EXPIRED", "KIR", vehicle.kirValidUntil],
  ] as const;
  for (const [code, label, until] of papers) {
    if (until !== null && until < today) found.push({ code, message: `${label} kendaraan ${vehicle.plateDisplay} habis berlaku ${until}.` });
  }
  return found;
}

const kgUnit = (uom: string) => uom.trim().toLowerCase() === "kg";
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Checks a stored registration. Throws the first hard refusal; answers the findings. Quantities held by other
 * registrations count only while their trips are not CANCELLED, EXPIRED or REJECTED.
 */
export async function checkRegistration(orm: Orm, registrationId: number, now: Date): Promise<Finding[]> {
  const [registration] = await orm.select().from(registrations).where(eq(registrations.id, registrationId));
  if (!registration) throw new Error(`Registration ${registrationId} does not exist.`);
  const today = todayAtPlant(now);
  const allocations = await orm
    .select({
      allocation: registrationAllocations,
      contractState: erpContracts.state,
      contractQty: erpContracts.qtyContract,
      contractOpening: erpContracts.qtyOpening,
      contractUom: erpContracts.uom,
      doStatus: deliveryOrders.status,
      doQty: deliveryOrders.qty,
      doUom: deliveryOrders.uom,
      deliveryFrom: deliveryOrders.deliveryFrom,
      deliveryUntil: deliveryOrders.deliveryUntil,
    })
    .from(registrationAllocations)
    .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
    .where(eq(registrationAllocations.registrationId, registrationId))
    .orderBy(registrationAllocations.seq);
  const tripRows = await orm
    .select({ trip: trips, vehicle: vehicles, driver: drivers })
    .from(trips)
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(eq(trips.registrationId, registrationId))
    .orderBy(trips.seq);
  const shares = tripRows.length
    ? await orm.select().from(tripAllocations).where(inArray(tripAllocations.tripId, tripRows.map((row) => row.trip.id)))
    : [];

  // hard refusals
  for (const { allocation, contractState, doStatus } of allocations) {
    if (allocation.contractId !== null && contractState !== "OPEN") {
      throw refused("CONTRACT_NOT_AVAILABLE", `Kontrak ${allocation.contractNo} tidak terbuka lagi.`);
    }
    if (allocation.deliveryOrderId !== null && doStatus !== "ACCEPTED") {
      throw refused("DO_NOT_AVAILABLE", `DO ${allocation.doNo ?? "-"} tidak berstatus diterima.`);
    }
  }
  const policy = await driverPolicy(orm, registration.siteId);
  const findings: Finding[] = [];
  for (const { trip, vehicle, driver } of tripRows) {
    const tripSeq = trip.seq;
    if (driver) {
      const verdict = registryVerdict(policy, driver.registryStatus, driver.fullName);
      if (verdict?.level === "BLOCK") throw refused(verdict.code, verdict.message);
      if (await isDriverBlocked(orm, driver.id, now)) throw refused("DRIVER_BLOCKED", `Supir ${driver.fullName} sedang diblokir.`);
      if (verdict) findings.push({ code: verdict.code, message: verdict.message, tripSeq });
      if (driver.licenceValidUntil !== null && driver.licenceValidUntil < today) {
        findings.push({ code: "LICENCE_EXPIRED", message: `SIM ${driver.fullName} habis berlaku ${driver.licenceValidUntil}.`, tripSeq });
      }
    }
    if (vehicle) {
      for (const found of vehicleFindings(vehicle, today)) findings.push({ ...found, tripSeq });
      const kg = shares
        .filter((share) => share.tripId === trip.id)
        .reduce((sum, share) => {
          const row = allocations.find((item) => item.allocation.id === share.registrationAllocationId);
          return row && kgUnit(row.doUom ?? row.contractUom ?? "") ? sum + (share.qtyPlanned ?? 0) : sum;
        }, 0);
      if (registration.direction === "OUT" && vehicle.capacityKg !== null && kg > vehicle.capacityKg) {
        findings.push({ code: "OVER_CAPACITY", message: `Rencana ${round3(kg)} kg melebihi daya angkut ${vehicle.plateDisplay} (${vehicle.capacityKg} kg).`, tripSeq });
      }
    }
    if (registration.direction === "OUT" && trip.plannedArrival !== null) {
      for (const { allocation, deliveryFrom, deliveryUntil } of allocations) {
        if (deliveryFrom === null) continue;
        if (trip.plannedArrival < deliveryFrom || (deliveryUntil !== null && trip.plannedArrival > deliveryUntil)) {
          findings.push({
            code: "OUTSIDE_DELIVERY_WINDOW",
            message: `Tanggal datang ${trip.plannedArrival} di luar masa kirim DO ${allocation.doNo ?? ""} (${deliveryFrom} sampai ${deliveryUntil ?? "selesai"}).`,
            tripSeq,
            allocationSeq: allocation.seq,
          });
        }
      }
    }
  }

  // quantities against the contract (incoming, kilograms) or the DO (outgoing)
  for (const row of allocations) {
    const { allocation } = row;
    const mine = shares.filter((share) => share.registrationAllocationId === allocation.id);
    if (allocation.contractId !== null && registration.direction === "IN") {
      if (row.contractQty === null || !kgUnit(row.contractUom ?? "")) continue;
      const own = mine.reduce((sum, share) => sum + (share.originNetKg ?? 0), 0);
      if (own === 0) continue;
      const used = await heldByOthers(orm, registrationId, eq(registrationAllocations.contractId, allocation.contractId), "originNetKg");
      const remaining = round3(row.contractQty - (row.contractOpening ?? 0) - used);
      if (own > remaining) {
        findings.push({ code: "OVER_CONTRACT", message: `Netto surat ${own} kg melebihi sisa kontrak ${allocation.contractNo} (${remaining} kg).`, tripSeq: 1, allocationSeq: allocation.seq });
      }
    }
    if (allocation.deliveryOrderId !== null && row.doQty !== null) {
      const own = round3(mine.reduce((sum, share) => sum + (share.qtyPlanned ?? 0), 0));
      const used = await heldByOthers(orm, registrationId, eq(registrationAllocations.deliveryOrderId, allocation.deliveryOrderId), "qtyPlanned");
      const remaining = round3(row.doQty - used);
      if (own > remaining) {
        findings.push({ code: "OVER_DO", message: `Rencana ${own} ${row.doUom ?? ""} melebihi sisa DO ${allocation.doNo ?? ""} (${remaining}).`, allocationSeq: allocation.seq });
      }
    }
  }
  return findings;
}

/** Quantity of a contract or DO held by the trips of other registrations that still count. */
async function heldByOthers(orm: Orm, registrationId: number, target: ReturnType<typeof eq>, column: "originNetKg" | "qtyPlanned"): Promise<number> {
  const rows = await orm
    .select({ value: tripAllocations[column] })
    .from(tripAllocations)
    .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
    .innerJoin(trips, eq(trips.id, tripAllocations.tripId))
    .where(and(target, ne(trips.registrationId, registrationId), notInArray(trips.status, RELEASED_STATUSES)));
  return rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
}

/** Remaining quantity of a DO, counting every registration except the one given. */
export async function doRemaining(orm: Orm, deliveryOrderId: number, qty: number, exceptRegistrationId: number | null): Promise<number> {
  return round3(qty - (await heldByOthers(orm, exceptRegistrationId ?? -1, eq(registrationAllocations.deliveryOrderId, deliveryOrderId), "qtyPlanned")));
}
