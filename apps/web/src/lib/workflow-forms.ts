// Values, checks and request bodies of the phase 3 forms: RFID card, delivery
// order, and the incoming and outgoing registration. Form state is kept as
// strings (what the inputs hold); the payload builders turn it into the types
// of section 3 of docs/fase-3-rancangan.md. Errors of nested parts are keyed
// by path ("truck.plate", "letters.1.originNetKg", "trucks.0.licenceNo").

import { formatNumber } from "@/lib/format";
import { driverPayload, validateDriver, validateVehicle, type DriverValues } from "@/lib/forms";
import { cardUidError, normalizeCardUid } from "@/lib/gate-input";
import { plateDisplay, plateError, plateKey } from "@/lib/plate";
import { wholeKg } from "@/lib/quantity";
import type { Contract, DeliveryOrder, Driver, PartnerRef, QualityParameter, Vehicle, VehicleType } from "@/lib/types";

export type FormErrors = Record<string, string>;

const text = (value: string): string => value.trim();
const textOrNull = (value: string): string | null => value.trim() || null;

/** "3,5" or "3.5" -> 3.5. No grouping signs, no minus. */
export function decimalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+([.,]\d+)?$/.test(trimmed)) return null;
  return Number(trimmed.replace(",", "."));
}

function numberOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function prefixed(prefix: string, errors: FormErrors): FormErrors {
  return Object.fromEntries(Object.entries(errors).map(([key, message]) => [`${prefix}.${key}`, message]));
}

// --- lookups of the master data -----------------------------------------------

/**
 * Result of looking a plate or licence number up. `key` is the normalised text
 * that was looked up, so a lookup stops counting once the field is edited.
 */
export type Lookup<T> =
  | { state: "idle" }
  | { state: "loading"; key: string }
  | { state: "found"; key: string; item: T }
  | { state: "missing"; key: string }
  | { state: "failed"; key: string };

export const licenceKey = (value: string): string => value.replace(/\s+/g, "").toUpperCase();

/** The lookup when it belongs to the current text, otherwise idle. */
export function currentLookup<T>(lookup: Lookup<T>, key: string): Lookup<T> {
  return lookup.state !== "idle" && lookup.key === key ? lookup : { state: "idle" };
}

// --- one truck: vehicle, driver, container ------------------------------------

export interface TruckValues {
  /** Local key for React lists; never sent. */
  key: string;
  plate: string;
  vehicle: Lookup<Vehicle>;
  vehicleTypeCode: string;
  capacityKg: string;
  productionYear: string;
  tareKg: string;
  stnkValidUntil: string;
  taxValidUntil: string;
  kirValidUntil: string;
  licenceNo: string;
  driver: Lookup<Driver>;
  fullName: string;
  licenceClass: string;
  licenceValidUntil: string;
  phone: string;
  containerNo: string;
  handoverNo: string;
}

export function emptyTruck(key: string): TruckValues {
  return {
    key,
    plate: "",
    vehicle: { state: "idle" },
    vehicleTypeCode: "",
    capacityKg: "",
    productionYear: "",
    tareKg: "",
    stnkValidUntil: "",
    taxValidUntil: "",
    kirValidUntil: "",
    licenceNo: "",
    driver: { state: "idle" },
    fullName: "",
    licenceClass: "",
    licenceValidUntil: "",
    phone: "",
    containerNo: "",
    handoverNo: "",
  };
}

export interface FormContext {
  types: readonly VehicleType[];
  parameters: readonly QualityParameter[];
  currentYear: number;
}

/** Type code of the truck: the one of the vehicle found, or the one chosen for a new vehicle. */
export function truckTypeCode(truck: TruckValues): string | null {
  const vehicle = currentLookup(truck.vehicle, plateKey(truck.plate));
  if (vehicle.state === "found") return vehicle.item.vehicleTypeCode;
  if (vehicle.state === "missing") return truck.vehicleTypeCode || null;
  return null;
}

export function needsContainer(truck: TruckValues, types: readonly VehicleType[]): boolean {
  const code = truckTypeCode(truck);
  return !!code && types.some((type) => type.code === code && type.needsContainerNo);
}

export function isBlacklisted(driver: Driver | null | undefined): boolean {
  return driver?.registryStatus?.trim().toUpperCase() === "BLACKLIST";
}

function newDriverValues(truck: TruckValues): DriverValues {
  return {
    fullName: truck.fullName,
    licenceNo: truck.licenceNo,
    licenceClass: truck.licenceClass,
    licenceValidUntil: truck.licenceValidUntil,
    phone: truck.phone,
  };
}

export function validateTruck(truck: TruckValues, context: Pick<FormContext, "types" | "currentYear">): FormErrors {
  const errors: FormErrors = {};

  const plateProblem = plateError(truck.plate);
  if (plateProblem) {
    errors.plate = plateProblem;
  } else {
    const vehicle = currentLookup(truck.vehicle, plateKey(truck.plate));
    if (vehicle.state === "idle" || vehicle.state === "loading") errors.plate = "Tekan Periksa untuk mencari plat ini.";
    else if (vehicle.state === "failed") errors.plate = "Plat belum bisa diperiksa. Tekan Periksa lagi.";
    else if (vehicle.state === "missing") {
      if (!truck.vehicleTypeCode) errors.vehicleTypeCode = "Pilih jenis kendaraan.";
      const vehicleErrors = validateVehicle(
        {
          plateDisplay: truck.plate,
          vehicleTypeCode: truck.vehicleTypeCode,
          ownerPartnerId: "",
          ownership: "",
          capacityKg: truck.capacityKg,
          productionYear: truck.productionYear,
          tareKg: truck.tareKg,
          tareReason: "",
          stnkValidUntil: truck.stnkValidUntil,
          taxValidUntil: truck.taxValidUntil,
          kirValidUntil: truck.kirValidUntil,
          isActive: true,
        },
        null,
        context.currentYear,
      );
      for (const name of ["capacityKg", "productionYear", "tareKg"] as const) {
        if (vehicleErrors[name]) errors[name] = vehicleErrors[name];
      }
    }
  }

  if (!text(truck.licenceNo)) {
    errors.licenceNo = "Isi nomor SIM.";
  } else {
    const driver = currentLookup(truck.driver, licenceKey(truck.licenceNo));
    if (driver.state === "idle" || driver.state === "loading") errors.licenceNo = "Tekan Periksa untuk mencari nomor SIM ini.";
    else if (driver.state === "failed") errors.licenceNo = "Nomor SIM belum bisa diperiksa. Tekan Periksa lagi.";
    else if (driver.state === "found" && isBlacklisted(driver.item)) {
      errors.licenceNo = "Supir ini masuk daftar hitam VCF dan tidak bisa didaftarkan.";
    } else if (driver.state === "missing") {
      const driverErrors = validateDriver(newDriverValues(truck));
      for (const name of ["fullName", "licenceClass", "licenceValidUntil", "phone"] as const) {
        if (driverErrors[name]) errors[name] = driverErrors[name];
      }
    }
  }

  if (needsContainer(truck, context.types) && !text(truck.containerNo)) errors.containerNo = "Isi nomor kontainer.";
  return errors;
}

export function truckPayload(truck: TruckValues): Record<string, unknown> {
  const vehicle = currentLookup(truck.vehicle, plateKey(truck.plate));
  const driver = currentLookup(truck.driver, licenceKey(truck.licenceNo));
  const body: Record<string, unknown> = {};

  if (vehicle.state === "found") {
    body.vehicle = { id: vehicle.item.id };
  } else {
    const created: Record<string, unknown> = {
      plateDisplay: plateDisplay(truck.plate),
      vehicleTypeCode: truck.vehicleTypeCode,
    };
    for (const name of ["capacityKg", "productionYear", "tareKg"] as const) {
      const value = wholeKg(truck[name]);
      if (value !== null) created[name] = value;
    }
    for (const name of ["stnkValidUntil", "taxValidUntil", "kirValidUntil"] as const) {
      if (truck[name]) created[name] = truck[name];
    }
    body.vehicle = created;
  }

  body.driver = driver.state === "found" ? { id: driver.item.id } : driverPayload(newDriverValues(truck));

  const containerNo = text(truck.containerNo).toUpperCase();
  if (containerNo) body.containerNo = containerNo;
  const handoverNo = text(truck.handoverNo);
  if (handoverNo) body.handoverNo = handoverNo;
  return body;
}

// --- letters of an incoming truck, one per contract ---------------------------

export interface LetterValues {
  handoverNo: string;
  spbNo: string;
  spbDate: string;
  originTicketNo: string;
  originGrossKg: string;
  originTareKg: string;
  originNetKg: string;
  /** Declared quality per parameter code. */
  quality: Record<string, string>;
}

export function emptyLetter(parameters: readonly QualityParameter[]): LetterValues {
  return {
    handoverNo: "",
    spbNo: "",
    spbDate: "",
    originTicketNo: "",
    originGrossKg: "",
    originTareKg: "",
    originNetKg: "",
    quality: Object.fromEntries(parameters.map((parameter) => [parameter.code, ""])),
  };
}

const KG_NAMES = ["originGrossKg", "originTareKg", "originNetKg"] as const;

export function validateLetter(letter: LetterValues, parameters: readonly QualityParameter[]): FormErrors {
  const errors: FormErrors = {};
  for (const name of KG_NAMES) {
    if (text(letter[name]) && wholeKg(letter[name]) === null) {
      errors[name] = "Isi angka bulat dalam kg, tanpa titik atau koma.";
    }
  }
  const [gross, tare, net] = KG_NAMES.map((name) => wholeKg(letter[name]));
  if (gross !== null && tare !== null && net !== null && net !== gross - tare && !errors.originNetKg) {
    errors.originNetKg = `Netto harus sama dengan bruto dikurangi tarra: ${formatNumber(gross - tare)} kg.`;
  }
  for (const parameter of parameters) {
    const raw = letter.quality[parameter.code] ?? "";
    if (!text(raw)) continue;
    const value = decimalNumber(raw);
    const min = numberOf(parameter.minValid) ?? 0;
    const max = numberOf(parameter.maxValid);
    if (value === null || value < min || (max !== null && value > max)) {
      errors[`quality.${parameter.code}`] =
        max === null ? `Isi angka paling kecil ${formatNumber(min)}.` : `Isi angka ${formatNumber(min)} sampai ${formatNumber(max)}.`;
    }
  }
  return errors;
}

export function letterPayload(letter: LetterValues, allocationSeq: number): Record<string, unknown> {
  const body: Record<string, unknown> = { allocationSeq };
  for (const name of ["handoverNo", "spbNo", "spbDate", "originTicketNo"] as const) {
    if (text(letter[name])) body[name] = text(letter[name]);
  }
  for (const name of KG_NAMES) {
    const value = wholeKg(letter[name]);
    if (value !== null) body[name] = value;
  }
  const quality: Record<string, number> = {};
  for (const [code, raw] of Object.entries(letter.quality)) {
    const value = decimalNumber(raw);
    if (value !== null) quality[code] = value;
  }
  if (Object.keys(quality).length > 0) body.quality = quality;
  return body;
}

// --- incoming registration ------------------------------------------------------

export interface IncomingValues {
  contracts: Contract[];
  transporter: PartnerRef | null;
  plannedDate: string;
  truck: TruckValues;
  /** One per contract, in the same order. */
  letters: LetterValues[];
  remark: string;
}

export function validateIncoming(values: IncomingValues, context: FormContext): FormErrors {
  let errors: FormErrors = {};
  if (values.contracts.length === 0) {
    errors.contracts = "Pilih paling sedikit satu kontrak.";
  } else if (new Set(values.contracts.map((contract) => String(contract.partner.id))).size > 1) {
    errors.contracts = "Semua kontrak dalam satu registrasi harus dari partner yang sama.";
  }
  errors = { ...errors, ...prefixed("truck", validateTruck(values.truck, context)) };
  values.letters.forEach((letter, index) => {
    errors = { ...errors, ...prefixed(`letters.${index}`, validateLetter(letter, context.parameters)) };
  });
  return errors;
}

export interface RegistrationBody {
  direction: "IN" | "OUT";
  transporterId?: string | number;
  plannedDate?: string;
  remark?: string;
  closeCargo?: boolean;
  flexiBag?: boolean;
  submit: boolean;
  allocations: Array<Record<string, unknown>>;
  trips: Array<Record<string, unknown>>;
}

function commonFields(body: RegistrationBody, values: { plannedDate: string; remark: string }): RegistrationBody {
  if (values.plannedDate) body.plannedDate = values.plannedDate;
  if (text(values.remark)) body.remark = text(values.remark);
  return body;
}

export function incomingPayload(values: IncomingValues, submit: boolean): RegistrationBody {
  const body: RegistrationBody = { direction: "IN", submit, allocations: [], trips: [] };
  if (values.transporter) body.transporterId = values.transporter.id;
  commonFields(body, values);
  body.allocations = values.contracts.map((contract) => ({ contractId: contract.id }));
  body.trips = [
    {
      ...truckPayload(values.truck),
      letters: values.letters.map((letter, index) => letterPayload(letter, index + 1)),
    },
  ];
  return body;
}

// --- outgoing registration -------------------------------------------------------

export type YesNo = "" | "yes" | "no";

export interface OutgoingValues {
  orders: Array<{ order: DeliveryOrder; qty: string }>;
  trucks: TruckValues[];
  closeCargo: YesNo;
  flexiBag: YesNo;
  plannedDate: string;
  remark: string;
}

export function validateOutgoing(values: OutgoingValues, context: FormContext, submit: boolean): FormErrors {
  let errors: FormErrors = {};
  if (values.orders.length === 0) errors.orders = "Pilih paling sedikit satu DO.";
  values.orders.forEach((entry, index) => {
    const qty = wholeKg(entry.qty);
    if (qty === null || qty <= 0) errors[`orders.${index}.qty`] = "Isi quantity dalam kg, angka bulat lebih dari nol.";
  });
  if (values.trucks.length === 0) errors.trucks = "Tambahkan paling sedikit satu truk.";

  const seenPlates = new Set<string>();
  const seenLicences = new Set<string>();
  values.trucks.forEach((truck, index) => {
    const own = validateTruck(truck, context);
    const plate = plateKey(truck.plate);
    const licence = licenceKey(truck.licenceNo);
    if (plate && !own.plate && seenPlates.has(plate)) own.plate = "Kendaraan ini sudah dipakai truk lain di registrasi ini.";
    if (licence && !own.licenceNo && seenLicences.has(licence)) {
      own.licenceNo = "Supir ini sudah dipakai truk lain di registrasi ini.";
    }
    if (plate) seenPlates.add(plate);
    if (licence) seenLicences.add(licence);
    errors = { ...errors, ...prefixed(`trucks.${index}`, own) };
  });

  if (submit) {
    if (!values.closeCargo) errors.closeCargo = "Pilih ya atau tidak.";
    if (!values.flexiBag) errors.flexiBag = "Pilih ya atau tidak.";
  }
  return errors;
}

export function outgoingPayload(values: OutgoingValues, submit: boolean): RegistrationBody {
  const body: RegistrationBody = { direction: "OUT", submit, allocations: [], trips: [] };
  // The trucks run for the transporter of the delivery orders.
  const transporter = values.orders.find((entry) => entry.order.transporter)?.order.transporter;
  if (transporter) body.transporterId = transporter.id;
  commonFields(body, values);
  if (values.closeCargo) body.closeCargo = values.closeCargo === "yes";
  if (values.flexiBag) body.flexiBag = values.flexiBag === "yes";
  body.allocations = values.orders.map((entry) => ({ deliveryOrderId: entry.order.id, qtyPlanned: wholeKg(entry.qty) }));
  body.trips = values.trucks.map(truckPayload);
  return body;
}

// --- delivery order ---------------------------------------------------------------

export interface DeliveryOrderValues {
  doNo: string;
  doDate: string;
  contractId: string;
  partnerId: string;
  productId: string;
  customerPoNo: string;
  qty: string;
  uom: string;
  tolerancePct: string;
  destinationId: string;
  deliveryFrom: string;
  deliveryUntil: string;
  transportTerms: string;
  transporterId: string;
  truckCount: string;
  remark: string;
}

export const EMPTY_DELIVERY_ORDER: DeliveryOrderValues = {
  doNo: "",
  doDate: "",
  contractId: "",
  partnerId: "",
  productId: "",
  customerPoNo: "",
  qty: "",
  uom: "Kg",
  tolerancePct: "",
  destinationId: "",
  deliveryFrom: "",
  deliveryUntil: "",
  transportTerms: "",
  transporterId: "",
  truckCount: "",
  remark: "",
};

export function validateDeliveryOrder(values: DeliveryOrderValues): FormErrors {
  const errors: FormErrors = {};
  if (!values.doDate) errors.doDate = "Isi tanggal DO.";
  if (!values.contractId) {
    if (!values.partnerId) errors.partnerId = "Pilih customer, atau pilih kontrak.";
    if (!values.productId) errors.productId = "Pilih barang.";
  }
  const qty = decimalNumber(values.qty);
  if (qty === null || qty <= 0) errors.qty = "Isi quantity lebih dari nol.";
  if (!values.destinationId) errors.destinationId = "Pilih tujuan.";
  if (!values.deliveryFrom) errors.deliveryFrom = "Isi tanggal mulai kirim.";
  if (values.deliveryFrom && values.deliveryUntil && values.deliveryUntil < values.deliveryFrom) {
    errors.deliveryUntil = "Tanggal akhir tidak boleh sebelum tanggal mulai.";
  }
  if (text(values.truckCount)) {
    const count = wholeKg(values.truckCount);
    if (count === null || count < 1) errors.truckCount = "Isi jumlah truk dengan angka bulat lebih dari nol.";
  }
  if (text(values.tolerancePct)) {
    const pct = decimalNumber(values.tolerancePct);
    if (pct === null || pct > 100) errors.tolerancePct = "Isi persen dari 0 sampai 100.";
  }
  return errors;
}

/**
 * "create": POST, empty fields left out. "draft": PATCH of a draft, every field
 * with null for empty. "limited": PATCH after sending, only the three fields the
 * API still accepts.
 */
export function deliveryOrderPayload(
  values: DeliveryOrderValues,
  mode: "create" | "draft" | "limited",
): Record<string, unknown> {
  const truckCount = wholeKg(values.truckCount);
  if (mode === "limited") {
    return { deliveryUntil: values.deliveryUntil || null, truckCount, remark: textOrNull(values.remark) };
  }
  const all: Record<string, unknown> = {
    doNo: textOrNull(values.doNo),
    doDate: values.doDate || null,
    contractId: values.contractId || null,
    partnerId: values.contractId ? null : values.partnerId || null,
    productId: values.contractId ? null : values.productId || null,
    customerPoNo: textOrNull(values.customerPoNo),
    qty: decimalNumber(values.qty),
    uom: textOrNull(values.uom),
    tolerancePct: text(values.tolerancePct) ? decimalNumber(values.tolerancePct) : null,
    destinationId: values.destinationId || null,
    deliveryFrom: values.deliveryFrom || null,
    deliveryUntil: values.deliveryUntil || null,
    transportTerms: textOrNull(values.transportTerms),
    transporterId: values.transporterId || null,
    truckCount,
    remark: textOrNull(values.remark),
  };
  if (mode === "draft") return all;
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== null));
}

// --- RFID card ---------------------------------------------------------------------

export interface CardValues {
  uid: string;
  label: string;
  note: string;
  status: string;
}

export function validateCard(values: CardValues, creating: boolean): FormErrors {
  const errors: FormErrors = {};
  if (creating) {
    const problem = cardUidError(normalizeCardUid(values.uid));
    if (problem) errors.uid = problem;
  }
  return errors;
}

export function cardPayload(values: CardValues, creating: boolean): Record<string, unknown> {
  if (creating) {
    const body: Record<string, unknown> = { uid: normalizeCardUid(values.uid) };
    if (text(values.label)) body.label = text(values.label);
    if (text(values.note)) body.note = text(values.note);
    return body;
  }
  const body: Record<string, unknown> = { label: textOrNull(values.label), note: textOrNull(values.note) };
  if (values.status) body.status = values.status;
  return body;
}
