// The registration post for a truck without an SPJ barcode: its paper is scanned, POST /api/gate/scan-document
// answers a proposal (what was read, how it matches the master data, what is still open), the operator checks and
// completes it, and POST /api/gate/walk-in registers the truck and checks it in with a card. Shapes follow
// apps/api src/gate/proposal.ts and walk-in-routes.ts. Everything here is plain data in, plain data out.
//
// The post does not type registrations. The exception is the emergency path: no scan, a scan the reading service
// could not take, or a document it could not read. Only an account with the module gate_emergency may then fill
// the form by hand, and it gives a reason.

import { isApiError } from "@/lib/api-client";
import { cargoMarkErrors, cargoMarkPayload, type CargoMarkValues } from "@/lib/cargo-marks";
import { errorMessage } from "@/lib/messages";
import { plateKey } from "@/lib/plate";
import { wholeKg } from "@/lib/quantity";
import type { StatusInfo } from "@/lib/status";
import type { Contract, DeliveryOrder, Direction, PartnerRef, QualityParameter, Registration, Trip } from "@/lib/types";
import {
  currentLookup,
  emptyLetter,
  emptyTruck,
  incomingPayload,
  licenceKey,
  needsContainer,
  outgoingPayload,
  registrationFieldErrors,
  truckTypeCode,
  validateIncoming,
  validateOutgoing,
  type FormContext,
  type FormErrors,
  type LetterValues,
  type RegistrationBody,
  type TruckValues,
} from "@/lib/workflow-forms";

type Id = string | number;

// --- what POST /api/gate/scan-document answers ----------------------------------------------------------

export type MatchStatus = "EXACT" | "CLOSE" | "NONE";

export interface Match<T, C = T, R = string | null> {
  status: MatchStatus;
  /** What the document says, as the service read it. */
  read: R;
  /** The row of the master data; set only when the status is EXACT. */
  value: T | null;
  /** Rows to choose from when the status is CLOSE, nearest first. */
  candidates: C[];
  note: string | null;
}

/** One value the service read, with its flag "have a look at this" and the reason it gave, if any. */
export interface ReadField {
  key: string;
  label: string;
  value: string | number | null;
  needsCheck: boolean;
  reason: string | null;
}

/** What the operator still has to choose or fill; `field` is a path of the registration body, or "document". */
export interface MissingField {
  field: string;
  message: string;
}

export interface ProposalContract {
  id: Id;
  contractNo: string;
  partner: PartnerRef;
  product: { id: Id; name: string; category: string | null };
  qtyContract: number | null;
  uom: string | null;
  validUntil: string | null;
  /** The contract is of the supplier the mill's name pointed to; null when no supplier was found for that name. */
  supplierMatches: boolean | null;
}
export type ContractCandidate = ProposalContract & { distance: number; lookalikeOnly: boolean };
export type ContractMatch = Match<ProposalContract, ContractCandidate>;
export type CompanyMatch = Match<PartnerRef, PartnerRef & { distance: number | null }>;

export interface ProposalVehicle {
  id: Id;
  plateNo: string;
  plateDisplay: string;
  vehicleTypeCode: string | null;
  needsContainerNo: boolean;
  owner: PartnerRef | null;
  verified: boolean;
}
/** `isNew`: the master has no such plate or licence, so the registration creates the row. */
export type VehicleMatch = Match<ProposalVehicle> & { isNew: boolean };

export interface ProposalDriver {
  id: Id;
  fullName: string;
  licenceNo: string;
  licenceClass: string | null;
  licenceValidUntil: string | null;
  registryStatus: string;
}
export type DriverCandidate = ProposalDriver & { distance: number | null };
export type DriverMatch = Match<ProposalDriver, DriverCandidate, { fullName: string | null; licenceNo: string | null }> & { isNew: boolean };

export type DeliveryOrderCandidate = DeliveryOrder & { distance: number; lookalikeOnly: boolean };
export type DeliveryOrderMatch = Match<DeliveryOrder, DeliveryOrderCandidate>;

interface DraftLetter {
  allocationSeq: number;
  handoverNo?: string;
  spbNo?: string;
  spbDate?: string;
  originGrossKg?: number;
  originTareKg?: number;
  originNetKg?: number;
  quality?: Record<string, number>;
}

/** The registration body as far as the document fills it. */
export interface DraftRegistration {
  direction: Direction;
  submit: true;
  plannedDate: string;
  transporterId?: Id;
  allocations: Array<{ contractId?: Id; deliveryOrderId?: Id }>;
  trips: Array<{
    vehicle: { id?: Id; plateDisplay?: string };
    driver: { id?: Id; licenceNo?: string; fullName?: string };
    plannedArrival: string;
    letters?: DraftLetter[];
  }>;
}

export interface LetterLine {
  seq: number;
  contractNo: string | null;
  handoverNo: string | null;
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
  /** True, false, or null when the three figures could not be compared. */
  netConsistent: boolean | null;
  netNote: string | null;
}

interface ProposalBase {
  scan: { fileId: Id; originalName: string | null; mimeType: string; sizeBytes: number };
  /** The service found too little on the page: the reading is shown, but the registration counts as typed. */
  unreadable: boolean;
  read: { fieldsFound: number | null; fieldsTotal: number | null; warnings: string[]; fields: ReadField[]; extraLines: ReadField[][] };
  missing: MissingField[];
  /** The complete body when nothing is missing; this app builds its own from the form, so it is not used. */
  registration: unknown;
  draft: DraftRegistration;
  timing?: { ocrMs: number };
}

export interface IncomingProposal extends ProposalBase {
  direction: "IN";
  matches: { supplier: CompanyMatch; transporter: CompanyMatch; contracts: ContractMatch[]; vehicle: VehicleMatch; driver: DriverMatch };
  letter: { spbNo: string | null; spbDate: string | null; lines: LetterLine[]; quality: Record<string, number> };
}

export interface OutgoingProposal extends ProposalBase {
  direction: "OUT";
  matches: { deliveryOrder: DeliveryOrderMatch };
}

export type ScanProposal = IncomingProposal | OutgoingProposal;

/** POST /api/gate/walk-in, 201. */
export interface WalkInResult {
  /** CHECKED_IN: the truck is in, with the card. REVIEW: registered, waiting for logistics, no card used. */
  state: "CHECKED_IN" | "REVIEW";
  emergency: boolean;
  message: string | null;
  registration: Registration;
  trip: Trip | null;
}

// --- what a walk-in rests on ------------------------------------------------------------------------------

export type WalkInBasis =
  /** A scan the service read: ordinary work of the post. */
  | { kind: "READ"; scanFileId: Id }
  /** A scan the service answered, but with too little found on it. */
  | { kind: "UNREADABLE"; scanFileId: Id }
  /** A scan that is kept, but the service did not read it (down, broken, too slow). */
  | { kind: "NOT_READ"; scanFileId: Id }
  /** No scan at all: the scanner is broken. */
  | { kind: "NO_SCAN" };

export const basisOf = (proposal: ScanProposal): WalkInBasis => ({ kind: proposal.unreadable ? "UNREADABLE" : "READ", scanFileId: proposal.scan.fileId });

/** The emergency path: the registration is typed by hand, which the API lets only holders of gate_emergency do. */
export const isEmergency = (basis: WalkInBasis): boolean => basis.kind !== "READ";

const EMERGENCY_WHY: Record<Exclude<WalkInBasis["kind"], "READ">, string> = {
  UNREADABLE: "Dokumen ini tidak terbaca dengan baik.",
  NOT_READ: "Dokumen ini belum terbaca oleh layanan baca dokumen. Scannya sudah disimpan.",
  NO_SCAN: "Registrasi ini tanpa scan dokumen.",
};

/** One or two sentences for the operator: why this is the emergency path, and what the account can do about it. */
export function emergencyText(basis: WalkInBasis, mayEmergency: boolean): string {
  if (basis.kind === "READ") return "";
  const next = mayEmergency
    ? "Isi datanya dengan tangan dan tulis alasannya; registrasi ini dicatat sebagai registrasi darurat."
    : basis.kind === "NO_SCAN"
      ? "Registrasi tanpa scan hanya untuk petugas dengan akses registrasi darurat."
      : "Pindai lagi, atau panggil petugas dengan akses registrasi darurat.";
  return `${EMERGENCY_WHY[basis.kind]} ${next}`;
}

const REASON_MIN = 3;
const REASON_MAX = 300;

/** The reason of an emergency registration: 3 to 300 characters, as the API checks it. */
export function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length === 0) return "Tulis alasan registrasi darurat.";
  if (length < REASON_MIN) return "Alasan terlalu pendek, paling sedikit 3 huruf.";
  if (length > REASON_MAX) return "Alasan terlalu panjang, paling banyak 300 huruf.";
  return null;
}

// --- when the scan was not read -----------------------------------------------------------------------------

export type ScanFailure =
  /** The scan is stored (when the API said which), but there is no reading: the emergency path, or scan again. */
  | { kind: "NOT_READ"; scanFileId: Id | null; message: string }
  /** The server has no reading service set up; nothing was stored. */
  | { kind: "NOT_CONFIGURED"; message: string }
  /** The file itself was refused: not a JPG or PNG, or too large. Another file may pass. */
  | { kind: "BAD_FILE"; message: string }
  | { kind: "OTHER"; message: string };

const NOT_READ_MESSAGES: Record<string, string> = {
  OCR_TIMEOUT: "Layanan baca dokumen terlalu lama menjawab.",
  OCR_FAILED: "Layanan baca dokumen sedang bermasalah.",
  OCR_UNAVAILABLE: "Layanan baca dokumen tidak bisa dihubungi.",
};

const asId = (value: unknown): Id | null => (typeof value === "number" || (typeof value === "string" && value !== "") ? value : null);

/** What went wrong with POST /api/gate/scan-document, in words for the operator. */
export function scanFailureOf(error: unknown): ScanFailure {
  if (!isApiError(error)) return { kind: "OTHER", message: errorMessage(error) };
  if (NOT_READ_MESSAGES[error.code]) return { kind: "NOT_READ", scanFileId: asId(error.details.scanFileId), message: NOT_READ_MESSAGES[error.code] };
  if (error.code === "NOT_CONFIGURED") return { kind: "NOT_CONFIGURED", message: "Layanan baca dokumen belum diatur di server ini. Hubungi admin sistem." };
  if (error.code === "FILE_TOO_LARGE" || error.status === 413) return { kind: "BAD_FILE", message: "Scan paling besar 15 MB. Pindai lagi dengan resolusi lebih rendah." };
  if (error.fieldMessages.file) return { kind: "BAD_FILE", message: "Scan harus gambar JPG atau PNG." };
  if (error.status === 403) return { kind: "OTHER", message: "Akun ini tidak punya izin memindai dokumen di pos." };
  return { kind: "OTHER", message: errorMessage(error) };
}

/** The basis of a walk-in after a failed reading: the kept scan, or none when nothing was stored. */
export function basisAfterFailure(failure: ScanFailure): WalkInBasis {
  return failure.kind === "NOT_READ" && failure.scanFileId !== null ? { kind: "NOT_READ", scanFileId: failure.scanFileId } : { kind: "NO_SCAN" };
}

/** A file the scan route would refuse, told before it is sent; null when it may go. */
export function scanFileError(file: { type: string; size: number }): string | null {
  if (file.type !== "image/jpeg" && file.type !== "image/png") return "Pilih gambar JPG atau PNG.";
  if (file.size > 15 * 1024 * 1024) return "Scan paling besar 15 MB.";
  if (file.size === 0) return "Berkas ini kosong.";
  return null;
}

// --- the form of a walk-in ------------------------------------------------------------------------------------

/** One contract of an incoming truck with its letter. `source` is the row of the scanned letter it came from. */
export interface WalkInRow {
  key: string;
  source: number | null;
  contract: Contract | null;
  letter: LetterValues;
}

export interface IncomingWalkIn {
  direction: "IN";
  rows: WalkInRow[];
  transporter: PartnerRef | null;
  /** The operator decided to register without a transporter although the letter names one. */
  transporterSkipped: boolean;
  truck: TruckValues;
  remark: string;
}

export interface OutgoingWalkIn {
  direction: "OUT";
  order: DeliveryOrder | null;
  /** What this one truck loads, in kg. */
  qty: string;
  truck: TruckValues;
  marks: CargoMarkValues;
  remark: string;
}

export type WalkInForm = IncomingWalkIn | OutgoingWalkIn;

const asText = (value: number | string | null | undefined): string => (value === null || value === undefined ? "" : String(value));

/** A contract of the proposal in the shape the registration form keeps its contracts in. */
export function contractOf(view: ProposalContract): Contract {
  return {
    id: view.id,
    contractNo: view.contractNo,
    direction: "IN",
    partner: view.partner,
    product: view.product,
    qtyContract: view.qtyContract,
    uom: view.uom,
    tolerancePct: null,
    certificate: null,
    validFrom: null,
    validUntil: view.validUntil,
    customerPoNo: null,
    state: "OPEN",
    syncedAt: null,
  };
}

function letterOf(draft: DraftLetter | undefined, parameters: readonly QualityParameter[]): LetterValues {
  const letter = emptyLetter(parameters);
  if (!draft) return letter;
  return {
    ...letter,
    handoverNo: draft.handoverNo ?? "",
    spbNo: draft.spbNo ?? "",
    spbDate: draft.spbDate ?? "",
    originGrossKg: asText(draft.originGrossKg),
    originTareKg: asText(draft.originTareKg),
    originNetKg: asText(draft.originNetKg),
    quality: Object.fromEntries(parameters.map((parameter) => [parameter.code, asText(draft.quality?.[parameter.code])])),
  };
}

/**
 * The truck of a proposal: the plate and the licence number as found or as read. The form looks both up again,
 * which fills the vehicle and the driver the same way a typed plate does.
 */
function truckOf(vehicle: VehicleMatch | null, driver: DriverMatch | null): TruckValues {
  return {
    ...emptyTruck("truck"),
    plate: vehicle?.value?.plateDisplay ?? vehicle?.read ?? "",
    licenceNo: driver?.value?.licenceNo ?? driver?.read.licenceNo ?? "",
    // used only when the licence number turns out to be new
    fullName: driver?.value ? "" : (driver?.read.fullName ?? ""),
  };
}

/** The incoming form as the scanned letter fills it; without a proposal (emergency without a reading) it is empty. */
export function incomingStart(proposal: IncomingProposal | null, parameters: readonly QualityParameter[]): IncomingWalkIn {
  const letters = proposal?.draft.trips[0]?.letters ?? [];
  return {
    direction: "IN",
    rows: (proposal?.matches.contracts ?? []).map((match, index) => ({
      key: `row-${index}`,
      source: index,
      contract: match.value ? contractOf(match.value) : null,
      letter: letterOf(letters.find((letter) => letter.allocationSeq === index + 1), parameters),
    })),
    transporter: proposal?.matches.transporter.value ?? null,
    transporterSkipped: false,
    truck: truckOf(proposal?.matches.vehicle ?? null, proposal?.matches.driver ?? null),
    remark: "",
  };
}

/** The outgoing form: the delivery order when the scan settled it. Truck, driver and quantity are the operator's. */
export function outgoingStart(proposal: OutgoingProposal | null): OutgoingWalkIn {
  return {
    direction: "OUT",
    order: proposal?.matches.deliveryOrder.value ?? null,
    qty: "",
    truck: emptyTruck("truck"),
    marks: { closeCargo: "", flexiBag: "" },
    remark: "",
  };
}

// --- the list "still to do" ---------------------------------------------------------------------------------------

const vehicleSettled = (truck: TruckValues): boolean => truckTypeCode(truck) !== null;

function driverState(truck: TruckValues): "found" | "new" | "open" {
  const driver = currentLookup(truck.driver, licenceKey(truck.licenceNo));
  return driver.state === "found" ? "found" : driver.state === "missing" ? "new" : "open";
}

function netAgrees(letter: LetterValues | undefined): boolean {
  if (!letter) return true;
  const [gross, tare, net] = [letter.originGrossKg, letter.originTareKg, letter.originNetKg].map(wholeKg);
  return gross === null || tare === null || net === null || net === gross - tare;
}

/** Whether the form as it stands settles one item of the proposal's `missing` list. An unknown path stays open. */
export function missingDone(form: WalkInForm, field: string): boolean {
  const truck = form.truck;
  const driver = driverState(truck);
  switch (field) {
    case "trips.0.vehicle":
    case "trips.0.vehicle.vehicleTypeCode":
      return vehicleSettled(truck);
    case "trips.0.containerNo":
      return truck.containerNo.trim() !== "";
    case "trips.0.driver":
      return driver === "found" || (driver === "new" && [truck.fullName, truck.licenceClass, truck.licenceValidUntil].every((value) => value.trim() !== ""));
    case "trips.0.driver.licenceNo":
      return driver !== "open";
    case "trips.0.driver.fullName":
      return driver === "found" || (driver === "new" && truck.fullName.trim() !== "");
    case "trips.0.driver.licenceClass":
      return driver === "found" || (driver === "new" && truck.licenceClass !== "");
    case "trips.0.driver.licenceValidUntil":
      return driver === "found" || (driver === "new" && truck.licenceValidUntil !== "");
  }
  if (form.direction === "OUT") {
    if (field === "allocations.0.deliveryOrderId") return form.order !== null;
    if (field === "allocations.0.qtyPlanned") return (wholeKg(form.qty) ?? 0) > 0;
    if (field === "closeCargo") return form.marks.closeCargo !== "";
    if (field === "flexiBag") return form.marks.flexiBag !== "";
    return false;
  }
  if (field === "transporterId") return form.transporter !== null || form.transporterSkipped;
  const contract = /^allocations\.(\d+)\.contractId$/.exec(field);
  if (contract) {
    const row = form.rows.find((item) => item.source === Number(contract[1]));
    // a row the operator took out has nothing left to choose
    return !row || row.contract !== null;
  }
  const net = /^trips\.0\.letters\.(\d+)\.originNetKg$/.exec(field);
  if (net) return netAgrees(form.rows.find((item) => item.source === Number(net[1]))?.letter);
  return false;
}

/** The proposal's `missing` list with a mark on what the form already settles. The note about the whole document is left out. */
export function todoList(missing: readonly MissingField[], form: WalkInForm): Array<MissingField & { done: boolean }> {
  return missing.filter((item) => item.field !== "document").map((item) => ({ ...item, done: missingDone(form, item.field) }));
}

// --- checks and the request ------------------------------------------------------------------------------------------

const ownPrefix = (errors: FormErrors, from: string, to: string): FormErrors =>
  Object.fromEntries(Object.entries(errors).map(([key, message]) => [key.startsWith(from) ? `${to}${key.slice(from.length)}` : key, message]));

/**
 * Checks of the form before the card is asked for. Error keys: "contracts", "rows.<n>.contract", "letters.<n>.…",
 * "transporter", "truck.…" for incoming; "order", "qty", "truck.…", "closeCargo", "flexiBag" for outgoing.
 */
export function validateWalkIn(form: WalkInForm, context: FormContext): FormErrors {
  if (form.direction === "IN") {
    const errors: FormErrors = {};
    form.rows.forEach((row, index) => {
      if (!row.contract) errors[`rows.${index}.contract`] = "Pilih kontraknya.";
    });
    const chosen = form.rows.filter((row) => row.contract !== null);
    return {
      ...validateIncoming(
        { contracts: chosen.map((row) => row.contract as Contract), transporter: form.transporter, plannedDate: "", truck: form.truck, letters: form.rows.map((row) => row.letter), remark: form.remark },
        context,
      ),
      ...errors,
    };
  }
  const errors = ownPrefix(
    validateOutgoing({ orders: form.order ? [{ order: form.order, qty: form.qty }] : [], trucks: [form.truck], plannedDate: "", remark: form.remark }, context),
    "trucks.0.",
    "truck.",
  );
  if (errors.orders) {
    errors.order = "Pilih DO.";
    delete errors.orders;
  }
  if (errors["orders.0.qty"] || form.order === null) {
    if ((wholeKg(form.qty) ?? 0) <= 0) errors.qty = "Isi quantity yang dimuat truk ini, dalam kg.";
    delete errors["orders.0.qty"];
  }
  return { ...errors, ...cargoMarkErrors(form.marks) };
}

/** The registration of a walk-in: one truck, sent at once. The API sets the dates to today. */
export function walkInRegistration(form: WalkInForm): RegistrationBody {
  if (form.direction === "IN") {
    return incomingPayload(
      {
        contracts: form.rows.flatMap((row) => (row.contract ? [row.contract] : [])),
        transporter: form.transporter,
        plannedDate: "",
        truck: form.truck,
        letters: form.rows.filter((row) => row.contract !== null).map((row) => row.letter),
        remark: form.remark,
      },
      true,
    );
  }
  return {
    ...outgoingPayload({ orders: form.order ? [{ order: form.order, qty: form.qty }] : [], trucks: [form.truck], plannedDate: "", remark: form.remark }, true),
    ...cargoMarkPayload(form.marks),
  };
}

export interface WalkInRequest {
  scanFileId?: Id;
  cardUid: string;
  registration: RegistrationBody;
  emergencyReason?: string;
}

/** The body of POST /api/gate/walk-in. The scan goes along whenever one was kept; the reason only on the emergency path. */
export function walkInRequest(basis: WalkInBasis, form: WalkInForm, cardUid: string, reason: string): WalkInRequest {
  return {
    ...(basis.kind === "NO_SCAN" ? {} : { scanFileId: basis.scanFileId }),
    cardUid,
    registration: walkInRegistration(form),
    ...(isEmergency(basis) ? { emergencyReason: reason.trim() } : {}),
  };
}

// --- refusals of the API, back onto the form ------------------------------------------------------------------------------

export interface WalkInRefusal {
  /** Messages for fields of the form, keyed as validateWalkIn keys them, plus "reason". */
  errors: FormErrors;
  /** The message for the card box. */
  card: string | null;
  /** Messages the form has no field for. */
  unplaced: string[];
}

/** The field messages of a VALIDATION refusal of POST /api/gate/walk-in on the fields of the form. */
export function walkInFieldErrors(direction: Direction, fieldMessages: Record<string, string>): WalkInRefusal {
  const inner: Record<string, string> = {};
  const errors: FormErrors = {};
  const unplaced: string[] = [];
  let card: string | null = null;
  for (const [path, message] of Object.entries(fieldMessages)) {
    if (path === "cardUid") card = message;
    else if (path === "emergencyReason") errors.reason = message;
    else if (path.startsWith("registration.")) inner[path.slice("registration.".length)] = message;
    else unplaced.push(message);
  }
  const placed = registrationFieldErrors(direction, inner);
  for (const [key, message] of Object.entries(placed.errors)) {
    const own =
      direction === "OUT"
        ? key === "orders"
          ? "order"
          : key === "orders.0.qty"
            ? "qty"
            : key.startsWith("trucks.0.")
              ? `truck.${key.slice("trucks.0.".length)}`
              : key
        : key;
    errors[own] = message;
  }
  return { errors, card, unplaced: [...unplaced, ...placed.unplaced] };
}

const WALK_IN_REFUSALS: Record<string, string> = {
  SCAN_ALREADY_USED: "Scan ini sudah dipakai untuk registrasi lain. Pindai dokumennya lagi.",
  CONTRACT_NOT_AVAILABLE: "Kontrak ini tidak terbuka lagi. Pilih kontrak lain.",
  DO_NOT_AVAILABLE: "DO ini belum diterima transporter atau sudah ditutup. Pilih DO lain.",
  DRIVER_BLACKLISTED: "Supir ini masuk daftar hitam VCF. Truk tidak bisa didaftarkan.",
  DRIVER_BLOCKED: "Supir ini sedang diblokir di pabrik. Truk tidak bisa didaftarkan.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
};

/**
 * A refusal of POST /api/gate/walk-in that is not about one field. A 403 with EMERGENCY_ACCESS_REQUIRED carries
 * the API's own sentence, written for the operator; other business rules (409) do too.
 */
export function walkInErrorMessage(error: unknown, unplaced: readonly string[] = []): string {
  if (isApiError(error)) {
    if (error.code === "EMERGENCY_ACCESS_REQUIRED") return error.message.trim() || "Registrasi ini butuh akses registrasi darurat. Pindai lagi, atau panggil petugas yang punya akses itu.";
    if (WALK_IN_REFUSALS[error.code]) return WALK_IN_REFUSALS[error.code];
    if (error.code === "VALIDATION" || error.status === 400) {
      return unplaced.length > 0 ? `Server menolak isian ini: ${unplaced.join(" ")}` : "Server menolak isian ini. Periksa kolom yang ditandai.";
    }
    if (error.status === 403) return "Akun ini tidak punya izin mendaftarkan truk di pos. Butuh hak akses Pos registrasi dan Registrasi tingkat buat.";
    if (error.status === 409 && error.message.trim()) return error.message.trim();
  }
  return errorMessage(error);
}

/** Whether a refusal means the account may not use the emergency path after all. */
export const isEmergencyRefusal = (error: unknown): boolean => isApiError(error) && error.code === "EMERGENCY_ACCESS_REQUIRED";

// --- small helpers for the screen ----------------------------------------------------------------------------------------------

const MATCH_INFO: Record<MatchStatus, StatusInfo> = {
  EXACT: { label: "Cocok", tone: "success" },
  CLOSE: { label: "Mirip, pilih yang benar", tone: "warning" },
  NONE: { label: "Tidak ditemukan", tone: "destructive" },
};

/** The badge of one match of the proposal. */
export function matchStatusInfo(status: MatchStatus): StatusInfo {
  return MATCH_INFO[status] ?? MATCH_INFO.NONE;
}

/** "12 dari 12 isian ditemukan", or null when the service did not say. */
export function foundText(read: { fieldsFound: number | null; fieldsTotal: number | null }): string | null {
  return read.fieldsFound === null || read.fieldsTotal === null ? null : `${read.fieldsFound} dari ${read.fieldsTotal} isian ditemukan`;
}

/** The value of a read field as text; a field the service could not read says so. */
export function readValueText(field: ReadField): string {
  return field.value === null || field.value === "" ? "tidak terbaca" : String(field.value);
}

/** Whether the plate in the form is still the one the document named. */
export function plateIsRead(form: WalkInForm, read: string | null): boolean {
  return read !== null && plateKey(form.truck.plate) === plateKey(read);
}

export { needsContainer };
