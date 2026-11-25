// What a scanned document becomes: the reading of the service, each value matched against the master data of
// this application, and a registration body the operator confirms. The reading is never the truth. A value is
// EXACT only when the master data holds one row for it, CLOSE when rows near it are offered to choose from, and
// NONE otherwise. The body is complete only when nothing is left to choose or to fill in; `missing` lists the
// rest with the field paths POST /api/registrations uses in its own messages.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { deliveryOrders, drivers, erpContracts, partners, products, qualityParameters, vehicles, vehicleTypes } from "../db/schema.js";
import { listDeliveryOrders } from "../delivery-orders/routes.js";
import { lettersAndDigits, todayAtPlant } from "../http.js";
import { registrationBody, type RegistrationInput } from "../registrations/service.js";
import { companyKey, compareNames, compareNumbers } from "./matching.js";
import type { Direction, OcrField, OcrReading } from "./ocr-client.js";

export const MAX_CONTRACT_CANDIDATES = 10;
export const MAX_NAME_CANDIDATES = 5;

export type MatchStatus = "EXACT" | "CLOSE" | "NONE";

export interface Match<T, C = T, R = string | null> {
  status: MatchStatus;
  /** What the document says, as the service read it. */
  read: R;
  /** The row of the master data; set only when the status is EXACT. */
  value: T | null;
  /** Rows to choose from when the status is CLOSE, nearest first. */
  candidates: C[];
  /** What the operator should know about this match; null when there is nothing to say. */
  note: string | null;
}

export interface MissingField {
  /** The path in the registration body, or "document" for the scan as a whole. */
  field: string;
  message: string;
}

interface Company {
  id: number;
  name: string;
}
type CompanyCandidate = Company & { distance: number | null };

interface ContractView {
  id: number;
  contractNo: string;
  partner: Company;
  product: { id: number; name: string; category: string };
  qtyContract: number | null;
  uom: string;
  validUntil: string | null;
  /** The contract is of the supplier the mill's name pointed to; null when no supplier was found for that name. */
  supplierMatches: boolean | null;
}
type ContractCandidate = ContractView & { distance: number; lookalikeOnly: boolean };

interface VehicleView {
  id: number;
  plateNo: string;
  plateDisplay: string;
  vehicleTypeCode: string;
  needsContainerNo: boolean;
  owner: Company | null;
  verified: boolean;
}

interface DriverView {
  id: number;
  fullName: string;
  licenceNo: string;
  licenceClass: string | null;
  licenceValidUntil: string | null;
  registryStatus: string;
}

type DeliveryOrderView = Awaited<ReturnType<typeof listDeliveryOrders>>[number];
type DeliveryOrderCandidate = DeliveryOrderView & { distance: number; lookalikeOnly: boolean };

/** The registration body as far as the document fills it; the same keys as POST /api/registrations. */
export interface DraftRegistration {
  direction: Direction;
  submit: true;
  plannedDate: string;
  transporterId?: number;
  allocations: { contractId?: number; deliveryOrderId?: number }[];
  trips: [
    {
      vehicle: { id?: number; plateDisplay?: string };
      driver: { id?: number; licenceNo?: string; fullName?: string };
      plannedArrival: string;
      letters?: {
        allocationSeq: number;
        handoverNo?: string;
        spbNo?: string;
        spbDate?: string;
        originGrossKg?: number;
        originTareKg?: number;
        originNetKg?: number;
        quality?: Record<string, number>;
      }[];
    },
  ];
}

const LABELS: Record<string, string> = {
  nomor_spb: "Nomor SPB",
  tanggal_spb: "Tanggal SPB",
  unit_usaha: "Unit usaha (PKS)",
  nomor_kontrak: "Nomor kontrak",
  no_order_penyerahan: "Order penyerahan",
  brutto_kg: "Bruto (kg)",
  tarra_kg: "Tarra (kg)",
  netto_kg: "Netto (kg)",
  no_polisi: "Nomor polisi",
  nama_supir: "Nama supir",
  no_sim: "Nomor SIM",
  transporter: "Transporter",
  ffa: "FFA (%)",
  kadar_air: "Kadar air (%)",
  kadar_kotoran: "Kadar kotoran (%)",
  suhu: "Suhu (°C)",
  ullage: "Ullage",
  keterangan: "Keterangan",
  nomor_do: "Nomor DO",
  tanggal: "Tanggal DO",
  nomor_po: "Nomor PO",
  pengangkut: "Pengangkut",
  tujuan: "Tujuan",
  jenis_barang: "Jenis barang",
  kuantitas: "Kuantitas",
  satuan: "Satuan",
  tanggal_jadwal: "Tanggal jadwal",
};
/** Quality figures of the letter and the parameter each one is stored under. */
const QUALITY_CODES: Record<string, string> = { ffa: "FFA", kadar_air: "MOISTURE", kadar_kotoran: "IMPURITIES" };
/** The fields that repeat on every row of a letter that carries more than one contract. */
const LINE_KEYS = ["nomor_kontrak", "no_order_penyerahan", "brutto_kg", "tarra_kg", "netto_kg"];
const MAX_KG = 2_000_000_000;

const shown = (field: OcrField) => ({ ...field, label: LABELS[field.key] ?? field.key });
const textOf = (field: OcrField | undefined): string | null => (field === undefined || field.value === null ? null : String(field.value).trim() || null);
const kgOf = (field: OcrField | undefined): number | null =>
  typeof field?.value === "number" && Number.isInteger(field.value) && field.value > 0 && field.value <= MAX_KG ? field.value : null;
/** A real calendar date as YYYY-MM-DD; "2026-02-31" is not one. */
const dateOf = (field: OcrField | undefined): string | null => {
  const text = textOf(field);
  if (text === null || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
};
/** A text short enough for the column it goes to; a longer one is left for the operator to type. */
const shortText = (field: OcrField | undefined, max: number): string | null => {
  const text = textOf(field);
  return text !== null && text.length <= max ? text : null;
};
const present = <T extends object>(values: T): T => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)) as T;

const none = <T, C>(read: string | null, note: string | null = null): Match<T, C> => ({ status: "NONE", read, value: null, candidates: [], note });

/** An active partner with this role, by the name on the document. */
async function matchCompany(orm: Orm, read: string | null, role: "supplier" | "transporter"): Promise<Match<Company, CompanyCandidate>> {
  if (read === null) return none(read);
  const rows = await orm
    .select({ id: partners.id, name: partners.name })
    .from(partners)
    .where(and(eq(partners.isActive, true), eq(role === "supplier" ? partners.isSupplier : partners.isTransporter, true)))
    .orderBy(asc(partners.id));
  const { equal, near } = compareNames(read, rows, (row) => row.name, companyKey);
  const [only] = equal;
  if (only && equal.length === 1) return { status: "EXACT", read, value: only, candidates: [], note: null };
  const candidates = [...equal.map((item) => ({ ...item, distance: 0 })), ...near.map(({ item, distance }) => ({ ...item, distance }))].slice(0, MAX_NAME_CANDIDATES);
  if (candidates.length === 0) return none(read);
  return { status: "CLOSE", read, value: null, candidates, note: equal.length > 1 ? "Ada lebih dari satu partner dengan nama ini." : null };
}

/** The open purchase contracts, loaded once for every row of the letter. */
const openContracts = (orm: Orm) =>
  orm
    .select({ id: erpContracts.id, contractNo: erpContracts.contractNo, partnerId: erpContracts.partnerId })
    .from(erpContracts)
    .where(and(eq(erpContracts.direction, "IN"), eq(erpContracts.state, "OPEN")))
    .orderBy(asc(erpContracts.id));

async function contractViews(orm: Orm, ids: number[], suppliers: Set<number> | null): Promise<Map<number, ContractView>> {
  if (ids.length === 0) return new Map();
  const rows = await orm
    .select({ contract: erpContracts, partnerName: partners.name, productName: products.name, productCategory: products.category })
    .from(erpContracts)
    .innerJoin(partners, eq(partners.id, erpContracts.partnerId))
    .innerJoin(products, eq(products.id, erpContracts.productId))
    .where(inArray(erpContracts.id, ids));
  return new Map(
    rows.map(({ contract, partnerName, productName, productCategory }) => [
      contract.id,
      {
        id: contract.id,
        contractNo: contract.contractNo,
        partner: { id: contract.partnerId, name: partnerName },
        product: { id: contract.productId, name: productName, category: productCategory },
        qtyContract: contract.qtyContract,
        uom: contract.uom,
        validUntil: contract.validUntil,
        supplierMatches: suppliers ? suppliers.has(contract.partnerId) : null,
      },
    ]),
  );
}

/**
 * The open purchase contract with this number. Without an equal one: the open contracts near the number,
 * those of the supplier the mill's name pointed to first, then the nearest.
 */
async function matchContract(
  orm: Orm,
  read: string | null,
  open: Awaited<ReturnType<typeof openContracts>>,
  suppliers: Set<number> | null,
): Promise<Match<ContractView, ContractCandidate>> {
  if (read === null) return none(read);
  const { equal, near } = compareNumbers(read, open, (row) => row.contractNo);
  const [only] = equal;
  if (only && equal.length === 1) {
    const exact = (await contractViews(orm, [only.id], suppliers)).get(only.id);
    // the number settles the contract; a mill's name that points to another supplier is told, not obeyed
    const note = exact?.supplierMatches === false ? `Kontrak ini milik ${exact.partner.name}, berbeda dari unit usaha di surat.` : null;
    if (exact) return { status: "EXACT", read, value: exact, candidates: [], note };
  }
  // several lines with exactly this number: the choice is among them, not among numbers that only look like it
  const ranked = equal.length > 1 ? equal.map((item) => ({ item, distance: 0, lookalikeOnly: false })) : [...near];
  // the sort is stable: within the supplier's contracts and within the others the nearest stays first
  if (suppliers) ranked.sort((a, b) => Number(suppliers.has(b.item.partnerId)) - Number(suppliers.has(a.item.partnerId)));
  const kept = ranked.slice(0, MAX_CONTRACT_CANDIDATES);
  const views = await contractViews(orm, kept.map((row) => row.item.id), suppliers);

  let note: string | null = null;
  if (equal.length > 1) note = "Nomor kontrak ini punya lebih dari satu baris barang. Pilih salah satu.";
  else {
    // a contract with exactly this number that is closed must not be mistaken for a misread open one
    const [closed] = await orm
      .select({ contractNo: erpContracts.contractNo })
      .from(erpContracts)
      .where(
        and(
          eq(erpContracts.direction, "IN"),
          ne(erpContracts.state, "OPEN"),
          sql`regexp_replace(upper(${erpContracts.contractNo}), '[^A-Z0-9]', '', 'g') = ${lettersAndDigits(read)}`,
        ),
      )
      .limit(1);
    if (closed) note = `Kontrak ${closed.contractNo} sudah ditutup atau dibatalkan.`;
  }
  const candidates = kept.flatMap(({ item, distance, lookalikeOnly }) => {
    const view = views.get(item.id);
    return view ? [{ ...view, distance, lookalikeOnly }] : [];
  });
  return { status: candidates.length > 0 ? "CLOSE" : "NONE", read, value: null, candidates, note };
}

/** `isNew`: nothing in the master has this plate or licence, so the registration creates the row from what was read. */
type VehicleMatch = Match<VehicleView> & { isNew: boolean };

/** The vehicle with this plate; a plate that is not in the master becomes a new vehicle at registration. */
async function matchVehicle(orm: Orm, read: string | null): Promise<VehicleMatch> {
  const unknown = (note: string, isNew = false): VehicleMatch => ({ ...none<VehicleView, VehicleView>(read, note), isNew });
  if (read === null) return unknown("Plat nomor tidak terbaca. Isi plat nomor.");
  const plateNo = lettersAndDigits(read);
  if (!/^[A-Z0-9]{3,12}$/.test(plateNo)) return unknown("Plat nomor yang terbaca tidak berbentuk plat. Isi plat nomor.");
  const [row] = await orm
    .select({ vehicle: vehicles, needsContainerNo: vehicleTypes.needsContainerNo, ownerName: partners.name })
    .from(vehicles)
    .leftJoin(vehicleTypes, eq(vehicleTypes.code, vehicles.vehicleTypeCode))
    .leftJoin(partners, eq(partners.id, vehicles.ownerPartnerId))
    .where(eq(vehicles.plateNo, plateNo))
    .limit(1);
  if (!row) return unknown("Plat belum terdaftar. Kendaraan baru dibuat saat registrasi; pilih jenis kendaraannya.", true);
  const { vehicle } = row;
  if (!vehicle.isActive) return unknown(`Kendaraan ${vehicle.plateDisplay} nonaktif. Aktifkan di master kendaraan atau pilih kendaraan lain.`);
  return {
    isNew: false,
    status: "EXACT",
    read,
    value: {
      id: vehicle.id,
      plateNo: vehicle.plateNo,
      plateDisplay: vehicle.plateDisplay,
      vehicleTypeCode: vehicle.vehicleTypeCode,
      needsContainerNo: row.needsContainerNo ?? false,
      owner: vehicle.ownerPartnerId !== null && row.ownerName !== null ? { id: vehicle.ownerPartnerId, name: row.ownerName } : null,
      verified: vehicle.verifiedAt !== null,
    },
    candidates: [],
    note: null,
  };
}

const driverColumns = {
  id: drivers.id,
  fullName: drivers.fullName,
  licenceNo: drivers.licenceNo,
  licenceClass: drivers.licenceClass,
  licenceValidUntil: drivers.licenceValidUntil,
  registryStatus: drivers.registryStatus,
};
type DriverRead = { fullName: string | null; licenceNo: string | null };
type DriverMatch = Match<DriverView, DriverView & { distance: number | null }, DriverRead> & { isNew: boolean };

/**
 * The driver with this licence number. Without one: the active drivers whose name is the one on the letter or
 * near it, to choose from. A name alone never settles who the driver is, since two drivers may share it.
 */
async function matchDriver(orm: Orm, read: DriverRead): Promise<DriverMatch> {
  const licenceNo = lettersAndDigits(read.licenceNo ?? "");
  if (!licenceNo && read.fullName === null) {
    return { status: "NONE", read, value: null, candidates: [], note: "Nama dan nomor SIM supir tidak terbaca. Pilih supir.", isNew: false };
  }
  if (licenceNo) {
    const [known] = await orm.select({ ...driverColumns, isActive: drivers.isActive }).from(drivers).where(eq(drivers.licenceNo, licenceNo)).limit(1);
    if (known) {
      const { isActive, ...value } = known;
      if (isActive) return { status: "EXACT", read, value, candidates: [], note: null, isNew: false };
      return { status: "NONE", read, value: null, candidates: [], note: `Supir ${value.fullName} dengan nomor SIM ini nonaktif. Pilih supir lain.`, isNew: false };
    }
  }
  if (read.fullName !== null) {
    const rows = await orm.select(driverColumns).from(drivers).where(eq(drivers.isActive, true)).orderBy(asc(drivers.id));
    const { equal, near } = compareNames(read.fullName, rows, (row) => row.fullName);
    const candidates = [...equal.map((item) => ({ ...item, distance: 0 })), ...near.map(({ item, distance }) => ({ ...item, distance }))].slice(0, MAX_NAME_CANDIDATES);
    if (candidates.length > 0) {
      const note = "Nomor SIM di surat tidak ada di master. Cocokkan nama dan nomor SIM sebelum memilih supir, atau isi sebagai supir baru.";
      return { status: "CLOSE", read, value: null, candidates, note, isNew: false };
    }
  }
  return { status: "NONE", read, value: null, candidates: [], note: "Supir belum terdaftar. Supir baru dibuat saat registrasi; isi jenis dan masa berlaku SIM.", isNew: true };
}

/** The delivery order with this number among the ones that may still be loaded (accepted by the transporter). */
async function matchDeliveryOrder(orm: Orm, read: string | null): Promise<Match<DeliveryOrderView, DeliveryOrderCandidate>> {
  if (read === null) return none(read);
  const all = await orm.select({ id: deliveryOrders.id, doNo: deliveryOrders.doNo, status: deliveryOrders.status }).from(deliveryOrders).orderBy(asc(deliveryOrders.id));
  const { equal, near } = compareNumbers(read, all.filter((row) => row.status === "ACCEPTED"), (row) => row.doNo);
  // an equal number settles it; near ones are offered only when there is none
  const ranked = (equal.length > 0 ? equal.map((item) => ({ item, distance: 0, lookalikeOnly: false })) : near).slice(0, MAX_CONTRACT_CANDIDATES);
  const ids = ranked.map((row) => row.item.id);
  const views = new Map((ids.length ? await listDeliveryOrders(orm, inArray(deliveryOrders.id, ids), ids.length) : []).map((view) => [view.id, view]));
  const [only] = equal;
  const exact = only && equal.length === 1 ? views.get(only.id) : undefined;
  if (exact) return { status: "EXACT", read, value: exact, candidates: [], note: null };

  let note: string | null = null;
  if (equal.length > 1) note = "Ada lebih dari satu DO dengan nomor ini. Pilih salah satu.";
  else {
    const same = compareNumbers(read, all.filter((row) => row.status !== "ACCEPTED"), (row) => row.doNo).equal[0];
    if (same) note = `DO ${same.doNo} berstatus ${same.status}: belum diterima transporter atau sudah ditutup.`;
  }
  const candidates = ranked.flatMap(({ item, distance, lookalikeOnly }) => {
    const view = views.get(item.id);
    return view ? [{ ...view, distance, lookalikeOnly }] : [];
  });
  return { status: candidates.length > 0 ? "CLOSE" : "NONE", read, value: null, candidates, note };
}

/** The usable quality figures of the letter: a known, active parameter and a value inside its valid range. */
async function qualityOf(orm: Orm, fields: Map<string, OcrField>): Promise<Record<string, number>> {
  const parameters = await orm.select().from(qualityParameters).where(inArray(qualityParameters.code, Object.values(QUALITY_CODES)));
  const quality: Record<string, number> = {};
  for (const [key, code] of Object.entries(QUALITY_CODES)) {
    const value = fields.get(key)?.value;
    const parameter = parameters.find((row) => row.code === code);
    if (typeof value === "number" && parameter?.isActive && value >= parameter.minValid && value <= parameter.maxValid) quality[code] = value;
  }
  return quality;
}

function readSection(reading: OcrReading) {
  return {
    fieldsFound: reading.fieldsFound,
    fieldsTotal: reading.fieldsTotal,
    warnings: reading.warnings,
    fields: reading.fields.map(shown),
    // the rows after the first of a letter that carries more than one contract
    extraLines: reading.lines.slice(1).map((line) => Object.values(line).map(shown)),
  };
}

/** The complete body when nothing is missing and the route's own schema takes it; else null and why. */
function settle(draft: DraftRegistration, missing: MissingField[]): { registration: RegistrationInput | null; missing: MissingField[] } {
  if (missing.length > 0) return { registration: null, missing };
  const parsed = registrationBody.safeParse(draft);
  if (parsed.success) return { registration: parsed.data, missing };
  return { registration: null, missing: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) };
}

const UNREADABLE: MissingField = { field: "document", message: "Dokumen tidak terbaca dengan baik. Periksa semua isian sebelum menyimpan." };

async function incomingProposal(orm: Orm, reading: OcrReading, today: string) {
  const fields = new Map(reading.fields.map((field) => [field.key, field]));
  const supplier = await matchCompany(orm, textOf(fields.get("unit_usaha")), "supplier");
  const transporter = await matchCompany(orm, textOf(fields.get("transporter")), "transporter");
  const vehicle = await matchVehicle(orm, textOf(fields.get("no_polisi")));
  const driver = await matchDriver(orm, { fullName: textOf(fields.get("nama_supir")), licenceNo: textOf(fields.get("no_sim")) });

  // contracts of the supplier found for the mill's name are offered first; a near name counts too
  const supplierIds = supplier.value ? [supplier.value.id] : supplier.candidates.map((candidate) => candidate.id);
  const suppliers = supplierIds.length > 0 ? new Set(supplierIds) : null;
  // a reading without its rows still has the first row among the fields
  const firstRow: Record<string, OcrField> = {};
  for (const key of LINE_KEYS) {
    const field = fields.get(key);
    if (field) firstRow[key] = field;
  }
  const rows = reading.lines.length > 0 ? reading.lines : [firstRow];
  const open = rows.some((row) => textOf(row.nomor_kontrak) !== null) ? await openContracts(orm) : [];
  const contracts: Match<ContractView, ContractCandidate>[] = [];
  for (const row of rows) contracts.push(await matchContract(orm, textOf(row.nomor_kontrak), open, suppliers));

  const quality = await qualityOf(orm, fields);
  const spbNo = shortText(fields.get("nomor_spb"), 60);
  const spbDate = dateOf(fields.get("tanggal_spb"));
  const lines = rows.map((row, index) => {
    const grossKg = kgOf(row.brutto_kg);
    const tareKg = kgOf(row.tarra_kg);
    const netKg = kgOf(row.netto_kg);
    const serviceReason = index === 0 ? reading.netConsistentReason : null;
    let netConsistent = grossKg !== null && tareKg !== null && netKg !== null ? netKg === grossKg - tareKg : null;
    let netNote: string | null = null;
    if (netConsistent === false) netNote = "Netto tidak sama dengan bruto dikurangi tarra.";
    else if (netConsistent === null) netNote = serviceReason ?? "Ada angka berat yang tidak terbaca.";
    else if (index === 0 && reading.netConsistent === null && serviceReason !== null) {
      // the service worked one figure out from the other two: the three agree, but that proves nothing
      netConsistent = null;
      netNote = serviceReason;
    }
    return { seq: index + 1, contractNo: textOf(row.nomor_kontrak), handoverNo: shortText(row.no_order_penyerahan, 60), grossKg, tareKg, netKg, netConsistent, netNote };
  });

  const missing: MissingField[] = reading.unreadable ? [UNREADABLE] : [];
  const draft: DraftRegistration = {
    direction: "IN",
    submit: true,
    plannedDate: today,
    ...(transporter.value ? { transporterId: transporter.value.id } : {}),
    allocations: contracts.map((match) => (match.value ? { contractId: match.value.id } : {})),
    trips: [
      {
        vehicle: vehicle.value ? { id: vehicle.value.id } : present({ plateDisplay: vehicle.isNew ? (vehicle.read ?? undefined) : undefined }),
        // what was read stays in the draft while candidates are offered, for the case that none of them is the driver
        driver: driver.value
          ? { id: driver.value.id }
          : driver.isNew || driver.status === "CLOSE"
            ? present({ licenceNo: driver.read.licenceNo ?? undefined, fullName: driver.read.fullName ?? undefined })
            : {},
        plannedArrival: today,
        letters: lines.map((line) =>
          present({
            allocationSeq: line.seq,
            handoverNo: line.handoverNo ?? undefined,
            spbNo: spbNo ?? undefined,
            spbDate: spbDate ?? undefined,
            originGrossKg: line.grossKg ?? undefined,
            originTareKg: line.tareKg ?? undefined,
            originNetKg: line.netKg ?? undefined,
            quality: Object.keys(quality).length > 0 ? quality : undefined,
          }),
        ),
      },
    ],
  };

  contracts.forEach((match, index) => {
    if (match.status === "EXACT") return;
    const message = match.read === null ? "Nomor kontrak tidak terbaca. Pilih kontraknya." : match.status === "CLOSE" ? "Nomor kontrak tidak persis sama. Pilih kontrak yang benar." : "Kontrak tidak ditemukan. Pilih kontraknya.";
    missing.push({ field: `allocations.${index}.contractId`, message });
  });
  if (transporter.read !== null && transporter.status !== "EXACT") {
    missing.push({ field: "transporterId", message: "Transporter di surat belum cocok dengan master. Pilih transporter, atau kosongkan." });
  }
  if (vehicle.isNew) missing.push({ field: "trips.0.vehicle.vehicleTypeCode", message: "Kendaraan belum terdaftar. Pilih jenis kendaraannya." });
  else if (!vehicle.value) missing.push({ field: "trips.0.vehicle", message: vehicle.note ?? "Pilih kendaraan." });
  else if (vehicle.value.needsContainerNo) missing.push({ field: "trips.0.containerNo", message: "Isi nomor kontainer untuk jenis kendaraan ini." });
  if (driver.isNew) {
    if (!/^[A-Z0-9]{6,20}$/.test(lettersAndDigits(driver.read.licenceNo ?? ""))) missing.push({ field: "trips.0.driver.licenceNo", message: "Nomor SIM tidak terbaca. Isi nomor SIM." });
    if (driver.read.fullName === null) missing.push({ field: "trips.0.driver.fullName", message: "Nama supir tidak terbaca. Isi nama supir." });
    missing.push({ field: "trips.0.driver.licenceClass", message: "Supir belum terdaftar. Isi jenis SIM." });
    missing.push({ field: "trips.0.driver.licenceValidUntil", message: "Supir belum terdaftar. Isi masa berlaku SIM." });
  } else if (!driver.value) {
    missing.push({ field: "trips.0.driver", message: driver.status === "CLOSE" ? "Pilih supir dari kandidat, atau isi data supir baru." : (driver.note ?? "Pilih supir.") });
  }
  lines.forEach((line, index) => {
    if (line.netConsistent === false) missing.push({ field: `trips.0.letters.${index}.originNetKg`, message: "Netto tidak sama dengan bruto dikurangi tarra. Periksa angka berat." });
  });

  return {
    matches: { supplier, transporter, contracts, vehicle, driver },
    letter: { spbNo, spbDate, lines, quality },
    draft,
    ...settle(draft, missing),
  };
}

async function outgoingProposal(orm: Orm, reading: OcrReading, today: string) {
  const fields = new Map(reading.fields.map((field) => [field.key, field]));
  const deliveryOrder = await matchDeliveryOrder(orm, textOf(fields.get("nomor_do")));
  const draft: DraftRegistration = {
    direction: "OUT",
    submit: true,
    plannedDate: today,
    allocations: [deliveryOrder.value ? { deliveryOrderId: deliveryOrder.value.id } : {}],
    // a delivery order does not name the truck or the driver: the operator chooses both
    trips: [{ vehicle: {}, driver: {}, plannedArrival: today }],
  };
  const missing: MissingField[] = reading.unreadable ? [UNREADABLE] : [];
  if (deliveryOrder.status !== "EXACT") {
    const message = deliveryOrder.read === null ? "Nomor DO tidak terbaca. Pilih DO." : deliveryOrder.status === "CLOSE" ? "Nomor DO tidak persis sama. Pilih DO yang benar." : "DO tidak ditemukan. Pilih DO.";
    missing.push({ field: "allocations.0.deliveryOrderId", message });
  }
  missing.push(
    { field: "allocations.0.qtyPlanned", message: "Isi quantity yang dimuat truk ini." },
    { field: "trips.0.vehicle", message: "Pilih kendaraan. Surat DO tidak memuat nomor polisi." },
    { field: "trips.0.driver", message: "Pilih supir. Surat DO tidak memuat nama supir." },
    { field: "closeCargo", message: "Jawab close cargo." },
    { field: "flexiBag", message: "Jawab flexi bag." },
  );
  return { matches: { deliveryOrder }, draft, ...settle(draft, missing) };
}

/** The proposal for one scanned document. Reads the master data and writes nothing. */
export async function buildProposal(orm: Orm, direction: Direction, reading: OcrReading, now: Date) {
  const today = todayAtPlant(now);
  const proposal = direction === "IN" ? await incomingProposal(orm, reading, today) : await outgoingProposal(orm, reading, today);
  return { direction, unreadable: reading.unreadable, read: readSection(reading), ...proposal };
}
