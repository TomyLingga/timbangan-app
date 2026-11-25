// Writing a registration (create and replace), submitting, approving, rejecting and cancelling it.
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Account } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import {
  deliveryOrders,
  drivers,
  erpContracts,
  partners,
  products,
  qualityParameters,
  qualityValues,
  registrationAllocations,
  registrations,
  spjDocuments,
  tripAllocations,
  tripFiles,
  trips,
  vehicles,
  vehicleTypes,
} from "../db/schema.js";
import { driverIdByLicence, insertDriver } from "../drivers/create.js";
import { AppError, invalid, invalidState, refused } from "../errors.js";
import { dateText, idNumber, lettersAndDigits } from "../http.js";
import { nextDocumentNo } from "../numbering.js";
import { defaultSite, readSetting, siteById } from "../settings.js";
import { issueSpj } from "../trips/spj.js";
import { ARRIVED_STATUSES } from "../trips/view.js";
import { SLIP_LABEL } from "../attachments/view.js";
import { hasSentRequest, hasShownRequest } from "../shipment-requests/view.js";
import { checkRegistration, doRemaining } from "./checks.js";

type Field = { field: string; message: string };
const fail = (fields: Field[]) => new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", fields);

const kg = (label: string) => {
  const message = `${label} harus bilangan bulat lebih dari 0.`;
  return z.number(message).int(message).positive(message).max(2_000_000_000, message);
};
const text = (label: string, max: number) => z.string(`${label} harus berupa teks.`).trim().max(max, `${label} terlalu panjang.`).optional();
const YEAR_MESSAGE = "Tahun pembuatan harus antara 1970 dan 2100.";

const vehicleBody = z.object({
  id: idNumber.optional(),
  plateDisplay: text("Plat nomor", 30),
  vehicleTypeCode: text("Jenis kendaraan", 30),
  capacityKg: kg("Daya angkut").optional(),
  productionYear: z.number(YEAR_MESSAGE).int(YEAR_MESSAGE).min(1970, YEAR_MESSAGE).max(2100, YEAR_MESSAGE).optional(),
  tareKg: kg("Tarra").optional(),
  stnkValidUntil: dateText("Masa berlaku STNK").optional(),
  taxValidUntil: dateText("Masa berlaku pajak").optional(),
  kirValidUntil: dateText("Masa berlaku KIR").optional(),
});
const driverBody = z.object({
  id: idNumber.optional(),
  licenceNo: text("Nomor SIM", 40),
  fullName: text("Nama supir", 200),
  licenceClass: text("Jenis SIM", 50),
  licenceValidUntil: dateText("Masa berlaku SIM").optional(),
  phone: text("Nomor telepon", 30),
});
const SEQ_MESSAGE = "allocationSeq harus nomor urut alokasi mulai dari 1.";
const letterBody = z.object({
  allocationSeq: z.number(SEQ_MESSAGE).int(SEQ_MESSAGE).min(1, SEQ_MESSAGE),
  handoverNo: text("Nomor penyerahan", 60),
  spbNo: text("Nomor SPB", 60),
  spbDate: dateText("Tanggal SPB").optional(),
  originTicketNo: text("Nomor tiket timbang asal", 60),
  originGrossKg: kg("Bruto asal").optional(),
  originTareKg: kg("Tarra asal").optional(),
  originNetKg: kg("Netto asal").optional(),
  quality: z.record(z.string(), z.number("Nilai spek harus angka.")).optional(),
});
const tripBody = z.object({
  vehicle: vehicleBody,
  driver: driverBody,
  containerNo: text("Nomor kontainer", 30),
  // outgoing, free and optional (owner, 25 November 2026)
  extraSpbe: text("SPBE tambahan", 200),
  passportNo: text("Passport atau surat jalan", 200),
  plannedArrival: dateText("Tanggal datang").optional(),
  handoverNo: text("Nomor penyerahan", 60),
  remark: text("Keterangan", 1000),
  letters: z.array(letterBody).max(10, "Terlalu banyak surat.").optional(),
});
const QTY_MESSAGE = "Quantity harus angka lebih dari 0.";
const allocationBody = z.object({
  contractId: idNumber.optional(),
  deliveryOrderId: idNumber.optional(),
  qtyPlanned: z.number(QTY_MESSAGE).positive(QTY_MESSAGE).max(1_000_000_000_000, QTY_MESSAGE).optional(),
});
export const registrationBody = z.object({
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT."),
  transporterId: idNumber.optional(),
  plannedDate: dateText("Tanggal rencana").optional(),
  remark: text("Keterangan", 1000),
  // asal PKS (incoming): set by staff, optional; a supplier account's registration always carries its own company
  originPartnerId: idNumber.nullable().optional(),
  closeCargo: z.boolean("closeCargo harus true atau false.").optional(),
  flexiBag: z.boolean("flexiBag harus true atau false.").optional(),
  submit: z.boolean("submit harus true atau false."),
  allocations: z.array(allocationBody, "Alokasi wajib diisi.").min(1, "Pilih minimal satu kontrak atau DO.").max(10, "Terlalu banyak kontrak atau DO."),
  trips: z.array(tripBody, "Daftar truk wajib diisi.").min(1, "Isi minimal satu truk.").max(200, "Paling banyak 200 truk."),
});
export type RegistrationInput = z.infer<typeof registrationBody>;

/**
 * Whether the account may write registrations of this direction at all, next to registrations:CREATE: a partner
 * account registers incoming trucks when its company is a supplier. Outgoing trucks are registered by the company a
 * DO was sent to, a transporter or the DO's own customer collecting its goods; writeRegistration refuses a DO that
 * was not sent to the account's company (DO_NOT_AVAILABLE), so no company flag is asked here.
 */
export function mayWrite(account: Account, direction: "IN" | "OUT"): boolean {
  if (account.kind === "INTERNAL") return true;
  return direction === "IN" ? account.partner?.isSupplier === true : account.partner !== null;
}

const requestNotSent = (contractNo: string) =>
  refused("SHIPMENT_REQUEST_REQUIRED", `Kontrak ${contractNo} belum dikirim INL ke perusahaan Anda. Truk hanya bisa didaftarkan untuk kontrak yang sudah dikirim.`);

/**
 * Refuses a supplier account's incoming registration when one of its contracts no longer has a SENT shipment
 * request to the account's company (closed or cancelled since the draft was written). Staff and outgoing
 * registrations pass.
 */
export async function assertRequestsSent(tx: Orm, account: Account, registrationId: number): Promise<void> {
  if (account.kind !== "PARTNER") return;
  const own = account.partner?.id ?? -1;
  const rows = await tx
    .select({ contractId: registrationAllocations.contractId, contractNo: registrationAllocations.contractNo })
    .from(registrationAllocations)
    .innerJoin(registrations, eq(registrations.id, registrationAllocations.registrationId))
    .where(and(eq(registrationAllocations.registrationId, registrationId), eq(registrations.direction, "IN")))
    .orderBy(registrationAllocations.seq);
  for (const row of rows) {
    if (row.contractId !== null && !(await hasSentRequest(tx, row.contractId, own))) throw requestNotSent(row.contractNo);
  }
}

const partnerMismatch = (items: { contractNo: string; partnerName: string }[]) =>
  refused(
    "CONTRACT_PARTNER_MISMATCH",
    `Kontrak dalam satu registrasi harus dari partner yang sama: ${items.map((item) => `${item.contractNo} (${item.partnerName})`).join(", ")}.`,
  );

interface Resolved {
  id: number;
  contractNo: string;
  doNo: string | null;
  contractId: number | null;
  deliveryOrderId: number | null;
  partnerId: number;
  partnerName: string;
  transporterId: number | null;
  siteId: number | null;
  category: string;
  uom: string;
  tolerancePct: number;
  qty: number | null;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Splits a quantity over `trucks`: every truck gets the same whole number, rounded down; the last one also
 * gets what is left. Null when the share would be zero.
 */
export function splitQuantity(total: number, trucks: number): number[] | null {
  const milli = Math.round(total * 1000);
  const each = Math.floor(milli / trucks / 1000) * 1000;
  if (each <= 0) return null;
  return Array.from({ length: trucks }, (_, index) => (index === trucks - 1 ? milli - each * (trucks - 1) : each) / 1000);
}

/**
 * Writes the content of a registration as a draft: new when `existing` is absent, else in place of the
 * draft's allocations and trips. Vehicles and drivers entered in place are created. Throws 400, 403-like
 * refusals (409) and leaves the transaction to roll back. Answers the registration id and the new drivers.
 * `createdVia` marks a new registration made another way than the form: "SCAN" for a walk-in from a scanned letter.
 */
export async function writeRegistration(
  tx: Orm,
  account: Account,
  body: RegistrationInput,
  now: Date,
  existing?: { id: number; regNo: string; createdBy: number; originPartnerId?: number | null },
  createdVia?: "SCAN",
): Promise<{ id: number; newDrivers: number[] }> {
  const fields: Field[] = [];
  const keys = body.allocations.map((allocation) => (body.direction === "IN" ? allocation.contractId : allocation.deliveryOrderId));
  if (body.direction === "IN") {
    if (body.allocations.some((allocation) => allocation.contractId === undefined || allocation.deliveryOrderId !== undefined)) {
      fields.push({ field: "allocations", message: "Registrasi masuk memakai kontrak beli (contractId)." });
    }
    if (body.trips.length !== 1) fields.push({ field: "trips", message: "Registrasi masuk berisi tepat satu truk." });
  } else if (body.allocations.some((allocation) => allocation.deliveryOrderId === undefined || allocation.contractId !== undefined)) {
    fields.push({ field: "allocations", message: "Registrasi keluar memakai DO (deliveryOrderId)." });
  }
  if (!fields.length && new Set(keys).size !== keys.length) fields.push({ field: "allocations", message: "Kontrak atau DO yang sama dipilih dua kali." });
  if (fields.length) throw fail(fields);

  // drafts being replaced give back what they held before anything is computed again; the weighbridge slips of a
  // truck are kept by its place in the list and linked again to the new row
  const keptSlips = existing
    ? await tx
        .select({ seq: trips.seq, fileId: tripFiles.fileId, label: tripFiles.label, addedBy: tripFiles.addedBy, addedAt: tripFiles.addedAt })
        .from(tripFiles)
        .innerJoin(trips, eq(trips.id, tripFiles.tripId))
        .where(and(eq(trips.registrationId, existing.id), eq(tripFiles.label, SLIP_LABEL)))
    : [];
  if (existing) {
    await tx.delete(trips).where(eq(trips.registrationId, existing.id));
    await tx.delete(registrationAllocations).where(eq(registrationAllocations.registrationId, existing.id));
  }

  const own = account.kind === "PARTNER" ? (account.partner?.id ?? -1) : null;
  const resolved: Resolved[] = [];
  for (const key of keys as number[]) {
    if (body.direction === "IN") {
      const [row] = await tx
        .select({ contract: erpContracts, category: products.category, partnerName: partners.name })
        .from(erpContracts)
        .innerJoin(products, eq(products.id, erpContracts.productId))
        .innerJoin(partners, eq(partners.id, erpContracts.partnerId))
        .where(eq(erpContracts.id, key));
      // a supplier account reaches a contract of its own company or one INL sent it a request on, whoever the
      // contract's partner is: a trader's contract is supplied by several mills (0018)
      const reachable = row && (own === null || row.contract.partnerId === own || (await hasShownRequest(tx, row.contract.id, own)));
      if (!row || !reachable || row.contract.direction !== "IN" || row.contract.state !== "OPEN") {
        throw refused("CONTRACT_NOT_AVAILABLE", "Kontrak tidak ditemukan, tidak terbuka, atau bukan untuk perusahaan Anda.");
      }
      const { contract } = row;
      // a supplier registers trucks only on a contract INL sent it a request for; staff at the post are not bound
      if (own !== null && !(await hasSentRequest(tx, contract.id, own))) throw requestNotSent(contract.contractNo);
      resolved.push({
        id: contract.id, contractNo: contract.contractNo, doNo: null, contractId: contract.id, deliveryOrderId: null, partnerId: contract.partnerId,
        partnerName: row.partnerName, transporterId: null, siteId: contract.siteId, category: row.category, uom: contract.uom, tolerancePct: contract.tolerancePct, qty: contract.qtyContract,
      });
    } else {
      const [row] = await tx
        .select({ order: deliveryOrders, category: products.category, partnerName: partners.name })
        .from(deliveryOrders)
        .innerJoin(products, eq(products.id, deliveryOrders.productId))
        .innerJoin(partners, eq(partners.id, deliveryOrders.partnerId))
        .where(eq(deliveryOrders.id, key))
        .for("update", { of: deliveryOrders });
      if (!row || row.order.status !== "ACCEPTED" || (own !== null && row.order.transporterId !== own)) {
        throw refused("DO_NOT_AVAILABLE", "DO tidak ditemukan, belum diterima, atau bukan untuk perusahaan Anda.");
      }
      const { order } = row;
      resolved.push({
        id: order.id, contractNo: order.contractNo ?? "-", doNo: order.doNo, contractId: null, deliveryOrderId: order.id, partnerId: order.partnerId,
        partnerName: row.partnerName, transporterId: order.transporterId, siteId: order.siteId, category: row.category, uom: order.uom, tolerancePct: order.tolerancePct, qty: order.qty,
      });
    }
  }
  const first = resolved[0];
  if (!first) throw new Error("A registration needs an allocation.");
  // the registration carries one partner, taken from its contracts: a truck carrying several contracts carries
  // contracts of one partner (owner's flow of 25 November 2026, incoming step 1.1)
  if (body.direction === "IN" && new Set(resolved.map((item) => item.partnerId)).size > 1) throw partnerMismatch(resolved);

  // asal PKS: the supplier account's own company; staff may name the mill, a draft keeps the one it had
  let originPartnerId: number | null = null;
  if (body.direction === "IN") {
    const given = own ?? (body.originPartnerId !== undefined ? body.originPartnerId : (existing?.originPartnerId ?? null));
    if (own === null && given !== null) {
      const [mill] = await tx.select({ isSupplier: partners.isSupplier }).from(partners).where(eq(partners.id, given));
      if (!mill?.isSupplier) throw invalid("originPartnerId", "Asal PKS harus partner supplier.");
    }
    originPartnerId = given;
  } else if (body.originPartnerId != null) throw invalid("originPartnerId", "Asal PKS hanya untuk registrasi masuk.");

  // flow and site
  const site = first.siteId !== null ? await siteById(tx, first.siteId) : await defaultSite(tx);
  const flowByCategory = (await readSetting<Record<string, Record<string, string>>>(tx, site.id, "flow_by_category")) ?? {};
  const flows = new Set(resolved.map((item) => flowByCategory[body.direction]?.[item.category]));
  const flowCode = [...flows][0];
  if (flows.size !== 1 || !flowCode) throw fail([{ field: "allocations", message: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang." }]);
  const maxPerTrip = (await readSetting<Record<string, number>>(tx, site.id, "max_contracts_per_trip"))?.[flowCode];
  if (maxPerTrip !== undefined && resolved.length > maxPerTrip) {
    throw fail([{ field: "allocations", message: `Satu truk paling banyak membawa ${maxPerTrip} kontrak atau DO pada jalur ini.` }]);
  }

  // transporter
  let transporterId: number | null;
  if (body.direction === "IN") {
    transporterId = body.transporterId ?? null;
    if (transporterId !== null) {
      const [partner] = await tx.select({ isTransporter: partners.isTransporter }).from(partners).where(eq(partners.id, transporterId));
      if (!partner?.isTransporter) throw invalid("transporterId", "Transporter harus partner transporter.");
    }
  } else {
    const transporters = new Set(resolved.map((item) => item.transporterId));
    if (transporters.size !== 1) throw fail([{ field: "allocations", message: "Semua DO dalam satu registrasi harus untuk transporter yang sama." }]);
    transporterId = own ?? first.transporterId;
  }

  // vehicles and drivers, created in place when needed
  const isStaff = account.kind === "INTERNAL";
  const newDrivers: number[] = [];
  const picked: { vehicleId: number | null; driverId: number | null }[] = [];
  for (const [index, trip] of body.trips.entries()) {
    const at = `trips.${index}`;
    let vehicleId: number | null = null;
    let needsContainer = false;
    if (trip.vehicle.id !== undefined) {
      const [vehicle] = await tx
        .select({ id: vehicles.id, isActive: vehicles.isActive, needsContainer: vehicleTypes.needsContainerNo })
        .from(vehicles)
        .innerJoin(vehicleTypes, eq(vehicleTypes.code, vehicles.vehicleTypeCode))
        .where(eq(vehicles.id, trip.vehicle.id));
      if (!vehicle?.isActive) fields.push({ field: `${at}.vehicle.id`, message: "Kendaraan tidak ditemukan." });
      else ({ id: vehicleId, needsContainer } = vehicle);
    } else {
      const { plateDisplay, vehicleTypeCode, ...rest } = trip.vehicle;
      if (!plateDisplay) fields.push({ field: `${at}.vehicle.plateDisplay`, message: "Plat nomor wajib diisi." });
      if (!vehicleTypeCode) fields.push({ field: `${at}.vehicle.vehicleTypeCode`, message: "Jenis kendaraan wajib diisi." });
      if (plateDisplay && vehicleTypeCode) {
        const plateNo = lettersAndDigits(plateDisplay);
        const [known] = await tx
          .select({ id: vehicles.id, needsContainer: vehicleTypes.needsContainerNo })
          .from(vehicles)
          .innerJoin(vehicleTypes, eq(vehicleTypes.code, vehicles.vehicleTypeCode))
          .where(eq(vehicles.plateNo, plateNo));
        const [type] = await tx.select().from(vehicleTypes).where(eq(vehicleTypes.code, vehicleTypeCode));
        if (known) ({ id: vehicleId, needsContainer } = known);
        else if (!/^[A-Z0-9]{3,12}$/.test(plateNo)) fields.push({ field: `${at}.vehicle.plateDisplay`, message: "Plat nomor harus 3 sampai 12 huruf atau angka." });
        else if (!type) fields.push({ field: `${at}.vehicle.vehicleTypeCode`, message: `Jenis kendaraan ${vehicleTypeCode} tidak ada.` });
        else {
          // a vehicle a partner enters belongs to the transporter and waits for logistics to verify it
          const [created] = await tx
            .insert(vehicles)
            .values({
              ...rest, plateNo, plateDisplay, vehicleTypeCode, ownerPartnerId: transporterId, createdBy: account.id,
              verifiedBy: isStaff ? account.id : null, verifiedAt: isStaff ? now : null, createdAt: now, updatedAt: now,
            })
            .returning({ id: vehicles.id });
          vehicleId = created?.id ?? null;
          needsContainer = type.needsContainerNo;
        }
      }
    }
    if (vehicleId !== null && needsContainer && !trip.containerNo) fields.push({ field: `${at}.containerNo`, message: "Nomor kontainer wajib diisi untuk jenis kendaraan ini." });

    let driverId: number | null = null;
    if (trip.driver.id !== undefined) {
      const [driver] = await tx.select({ id: drivers.id, isActive: drivers.isActive }).from(drivers).where(eq(drivers.id, trip.driver.id));
      if (!driver?.isActive) fields.push({ field: `${at}.driver.id`, message: "Supir tidak ditemukan." });
      else driverId = driver.id;
    } else {
      const { fullName, licenceClass, licenceValidUntil, phone } = trip.driver;
      const licenceNo = lettersAndDigits(trip.driver.licenceNo ?? "");
      const missing: Field[] = [];
      if (!licenceNo) missing.push({ field: `${at}.driver.licenceNo`, message: "Nomor SIM wajib diisi." });
      else if (!/^[A-Z0-9]{6,20}$/.test(licenceNo)) missing.push({ field: `${at}.driver.licenceNo`, message: "Nomor SIM harus 6 sampai 20 huruf atau angka." });
      const known = licenceNo ? await driverIdByLicence(tx, licenceNo) : null;
      if (known !== null) driverId = known;
      else {
        if (!fullName) missing.push({ field: `${at}.driver.fullName`, message: "Nama supir wajib diisi." });
        if (!licenceClass) missing.push({ field: `${at}.driver.licenceClass`, message: "Jenis SIM wajib diisi." });
        if (!licenceValidUntil) missing.push({ field: `${at}.driver.licenceValidUntil`, message: "Masa berlaku SIM wajib diisi." });
        if (missing.length) fields.push(...missing);
        else if (fullName && licenceClass && licenceValidUntil) {
          driverId = await insertDriver(tx, { fullName, licenceNo, licenceClass, licenceValidUntil, phone, homePartnerId: transporterId }, account.id, now);
          newDrivers.push(driverId);
        }
      }
    }
    picked.push({ vehicleId, driverId });

    for (const [letterIndex, letter] of (trip.letters ?? []).entries()) {
      const where = `${at}.letters.${letterIndex}`;
      if (body.direction !== "IN" || letter.allocationSeq > resolved.length || trip.letters?.findIndex((other) => other.allocationSeq === letter.allocationSeq) !== letterIndex) {
        fields.push({ field: `${where}.allocationSeq`, message: "Surat harus menunjuk satu alokasi yang ada, sekali saja." });
      }
      const { originGrossKg: gross, originTareKg: tare, originNetKg: net } = letter;
      if (gross !== undefined && tare !== undefined && net !== undefined && net !== gross - tare) {
        fields.push({ field: `${where}.originNetKg`, message: "Netto asal harus sama dengan bruto dikurangi tarra." });
      }
      for (const [code, value] of Object.entries(letter.quality ?? {})) {
        const [parameter] = await tx.select().from(qualityParameters).where(eq(qualityParameters.code, code));
        if (!parameter?.isActive) fields.push({ field: `${where}.quality.${code}`, message: `Parameter spek ${code} tidak dikenal.` });
        else if (value < parameter.minValid || value > parameter.maxValid) {
          fields.push({ field: `${where}.quality.${code}`, message: `${parameter.name} harus antara ${parameter.minValid} dan ${parameter.maxValid}.` });
        }
      }
    }
  }

  // quantity per truck: the origin nets (incoming) or the requested quantity split over the trucks (outgoing)
  const shares: (number | null)[][] = body.trips.map(() => resolved.map(() => null));
  const requested: (number | null)[] = resolved.map(() => null);
  if (body.direction === "OUT") {
    for (const [index, item] of resolved.entries()) {
      const wanted = body.allocations[index]?.qtyPlanned ?? (item.qty === null ? 0 : await doRemaining(tx, item.id, item.qty, existing?.id ?? null));
      const split = wanted > 0 ? splitQuantity(wanted, body.trips.length) : null;
      if (!split) {
        fields.push({ field: `allocations.${index}.qtyPlanned`, message: wanted > 0 ? `Quantity terlalu kecil untuk ${body.trips.length} truk.` : "Sisa DO sudah habis. Isi quantity." });
        continue;
      }
      requested[index] = round3(wanted);
      split.forEach((share, tripIndex) => {
        const row = shares[tripIndex];
        if (row) row[index] = share;
      });
    }
  } else {
    const letters = body.trips[0]?.letters ?? [];
    resolved.forEach((_, index) => {
      const net = letters.find((letter) => letter.allocationSeq === index + 1)?.originNetKg ?? null;
      requested[index] = net;
      const row = shares[0];
      if (row) row[index] = net;
    });
  }
  if (fields.length) throw fail(fields);

  const vehicleIds = picked.map((item) => item.vehicleId);
  if (new Set(vehicleIds).size !== vehicleIds.length) throw refused("DUPLICATE_VEHICLE", "Satu kendaraan dipakai dua kali dalam registrasi ini.");
  const driverIds = picked.map((item) => item.driverId);
  if (new Set(driverIds).size !== driverIds.length) throw refused("DUPLICATE_DRIVER", "Satu supir dipakai dua kali dalam registrasi ini.");

  // write
  const sameUnit = new Set(resolved.map((item) => item.uom.trim().toLowerCase())).size === 1;
  const sum = (values: (number | null)[]) => (values.some((value) => value !== null) && sameUnit ? round3(values.reduce<number>((total, value) => total + (value ?? 0), 0)) : null);
  const values = {
    siteId: site.id,
    direction: body.direction,
    flowCode: flowCode as "IN_CPO" | "IN_GOODS" | "OUT_BULK" | "OUT_PACKED",
    partnerId: first.partnerId,
    originPartnerId,
    transporterId,
    status: "DRAFT" as const,
    plannedDate: body.plannedDate ?? null,
    truckCount: body.trips.length,
    qtyTotal: sum(requested),
    uom: first.uom,
    closeCargo: body.closeCargo ?? null,
    flexiBag: body.flexiBag ?? null,
    remark: body.remark ?? null,
    checkFindings: [],
    updatedAt: now,
  };
  let registrationId: number;
  if (existing) {
    await tx.update(registrations).set(values).where(eq(registrations.id, existing.id));
    registrationId = existing.id;
  } else {
    const [created] = await tx
      .insert(registrations)
      .values({ ...values, regNo: await nextDocumentNo(tx, "REG", site.code, now), createdVia: createdVia ?? (isStaff ? "OPERATOR" : "PORTAL"), createdBy: account.id, createdAt: now })
      .returning({ id: registrations.id });
    if (!created) throw new Error("The registration was not created.");
    registrationId = created.id;
  }

  const allocationIds: number[] = [];
  for (const [index, item] of resolved.entries()) {
    const [row] = await tx
      .insert(registrationAllocations)
      .values({
        registrationId, seq: index + 1, contractId: item.contractId, deliveryOrderId: item.deliveryOrderId, qtyPlanned: requested[index] ?? null,
        contractNo: item.contractNo, doNo: item.doNo, tolerancePct: item.tolerancePct,
      })
      .returning({ id: registrationAllocations.id });
    if (!row) throw new Error("The allocation was not created.");
    allocationIds.push(row.id);
  }

  for (const [index, trip] of body.trips.entries()) {
    const own = shares[index] ?? [];
    const letters = trip.letters ?? [];
    const nets = letters.map((letter) => letter.originNetKg).filter((value): value is number => value !== undefined);
    const tares = letters.map((letter) => letter.originTareKg).filter((value): value is number => value !== undefined && value > 0);
    const docNet = nets.length ? nets.reduce((total, value) => total + value, 0) : null;
    const docTare = tares.length ? Math.min(...tares) : null;
    const [created] = await tx
      .insert(trips)
      .values({
        siteId: site.id,
        registrationId,
        seq: index + 1,
        status: "DRAFT",
        vehicleId: picked[index]?.vehicleId ?? null,
        driverId: picked[index]?.driverId ?? null,
        transporterId,
        containerNo: trip.containerNo ?? null,
        extraSpbe: body.direction === "OUT" ? trip.extraSpbe || null : null,
        passportNo: body.direction === "OUT" ? trip.passportNo || null : null,
        qtyPlanned: sum(own),
        plannedArrival: trip.plannedArrival ?? body.plannedDate ?? null,
        docNetKg: docNet,
        docTareKg: docTare,
        docGrossKg: docNet !== null && docTare !== null ? docNet + docTare : null,
        remark: trip.remark ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: trips.id });
    if (!created) throw new Error("The trip was not created.");
    const slips = keptSlips.filter((slip) => slip.seq === index + 1);
    if (slips.length) await tx.insert(tripFiles).values(slips.map(({ seq: _seq, ...slip }) => ({ ...slip, tripId: created.id })));
    for (const [allocationIndex, allocationId] of allocationIds.entries()) {
      const letter = letters.find((item) => item.allocationSeq === allocationIndex + 1);
      const [share] = await tx
        .insert(tripAllocations)
        .values({
          tripId: created.id,
          registrationAllocationId: allocationId,
          seq: allocationIndex + 1,
          qtyPlanned: own[allocationIndex] ?? null,
          handoverNo: letter?.handoverNo ?? trip.handoverNo ?? null,
          spbNo: letter?.spbNo ?? null,
          spbDate: letter?.spbDate ?? null,
          originTicketNo: letter?.originTicketNo ?? null,
          originGrossKg: letter?.originGrossKg ?? null,
          originTareKg: letter?.originTareKg ?? null,
          originNetKg: letter?.originNetKg ?? null,
        })
        .returning({ id: tripAllocations.id });
      if (!share) throw new Error("The trip allocation was not created.");
      const quality = Object.entries(letter?.quality ?? {});
      if (quality.length) {
        await tx.insert(qualityValues).values(quality.map(([parameterCode, value]) => ({ parameterCode, value, source: "DECLARED" as const, tripAllocationId: share.id })));
      }
    }
  }
  return { id: registrationId, newDrivers };
}

/** Runs the checks on a draft and stores the findings; the draft stays a draft. */
export async function storeFindings(tx: Orm, registrationId: number, now: Date): Promise<void> {
  const findings = await checkRegistration(tx, registrationId, now);
  await tx.update(registrations).set({ checkFindings: findings, updatedAt: now }).where(eq(registrations.id, registrationId));
}

/**
 * DRAFT to SUBMITTED, trips READY. Without findings (or when settings.registration_review says so) it is
 * approved at once and every truck gets its SPJ.
 */
export async function submitRegistration(tx: Orm, registrationId: number, actor: number, now: Date): Promise<void> {
  const [registration] = await tx.select().from(registrations).where(eq(registrations.id, registrationId)).for("update");
  if (!registration) throw new Error(`Registration ${registrationId} does not exist.`);
  if (registration.status !== "DRAFT") throw invalidState("Hanya registrasi berstatus DRAFT yang bisa dikirim.");
  // close cargo and flexi bag are no longer asked here: the post marks them per truck at check-in (0015)
  const findings = await checkRegistration(tx, registrationId, now);
  const review = (await readSetting<Record<string, string>>(tx, registration.siteId, "registration_review"))?.[registration.flowCode] ?? "ON_FAILED_CHECK";
  const needsReview = review === "ALWAYS" || (review !== "NEVER" && findings.length > 0);
  await tx.update(registrations).set({ status: "SUBMITTED", submittedAt: now, checkFindings: findings, updatedAt: now }).where(eq(registrations.id, registrationId));
  await tx.update(trips).set({ status: "READY", updatedAt: now }).where(eq(trips.registrationId, registrationId));
  if (!needsReview) await approve(tx, registrationId, actor, now, null);
}

/** SUBMITTED to APPROVED and an SPJ for every READY truck. `review` is null for an automatic approval. */
export async function approve(tx: Orm, registrationId: number, actor: number, now: Date, review: { note: string | null } | null): Promise<void> {
  await tx
    .update(registrations)
    .set({ status: "APPROVED", updatedAt: now, ...(review ? { reviewedBy: actor, reviewedAt: now, reviewNote: review.note } : {}) })
    .where(eq(registrations.id, registrationId));
  const ready = await tx.select({ id: trips.id }).from(trips).where(and(eq(trips.registrationId, registrationId), eq(trips.status, "READY"))).orderBy(trips.seq);
  for (const trip of ready) await issueSpj(tx, trip.id, actor, now);
}

/** Cancels the trips of a registration that have not arrived and revokes their SPJ. */
export async function cancelTrips(tx: Orm, registrationId: number, actor: number, now: Date, reason: string): Promise<void> {
  const open = await tx
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.registrationId, registrationId), notInArray(trips.status, ["CANCELLED", ...ARRIVED_STATUSES])));
  const ids = open.map((row) => row.id);
  if (!ids.length) return;
  await tx.update(trips).set({ status: "CANCELLED", cancelledAt: now, cancelReason: reason, updatedAt: now }).where(inArray(trips.id, ids));
  await tx.update(spjDocuments).set({ revokedAt: now, revokedBy: actor, revokeReason: reason }).where(and(inArray(spjDocuments.tripId, ids), isNull(spjDocuments.revokedAt)));
}

/** Whether any truck of the registration has checked in. */
export async function hasArrived(tx: Orm, registrationId: number): Promise<boolean> {
  const [arrived] = await tx.select({ id: trips.id }).from(trips).where(and(eq(trips.registrationId, registrationId), inArray(trips.status, ARRIVED_STATUSES))).limit(1);
  return arrived !== undefined;
}
