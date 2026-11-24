// The archive of the old weighbridge application (apps/api src/history/routes.ts): shapes the API answers and the
// helpers that turn its rows into what the "Riwayat lama" page shows. The archive is read only.

import type { StatusInfo } from "@/lib/status";

export type LegacyState = "COMPLETED" | "REJECTED_QC" | "REJECTED_CLEANLINESS" | "UNFINISHED";
export type LegacyDirection = "IN" | "OUT" | "UNKNOWN";

/** One row of GET /api/history/trips. Weights are whole kilograms; null when empty or not readable. */
export interface LegacyTrip {
  id: number;
  site: string;
  legacyId: number;
  ticketNo: string | null;
  direction: LegacyDirection;
  material: string | null;
  state: LegacyState;
  entryDate: string | null;
  arrivedAt: string | null;
  leftAt: string | null;
  plateText: string | null;
  plateNo: string | null;
  driverName: string | null;
  licenceNo: string | null;
  transporter: string | null;
  partnerName: string | null;
  mill: string | null;
  productName: string | null;
  uom: string | null;
  /** Contract number (incoming) or DO number (outgoing). */
  reference: string | null;
  doNo: string | null;
  poNo: string | null;
  spbNo: string | null;
  handoverNo: string | null;
  docGrossKg: number | null;
  docTareKg: number | null;
  docNetKg: number | null;
  /** Of the whole truck in a multi-contract group. */
  grossKg: number | null;
  tareKg: number | null;
  /** The share of this row in a multi-contract group. */
  netKg: number | null;
  weigh1At: string | null;
  weigh2At: string | null;
  weigh1By: string | null;
  weigh2By: string | null;
  /** Legacy id of the first row of a multi-contract group. */
  groupId: number | null;
  closeCargo: boolean | null;
  flexiBag: boolean | null;
  /**
   * Incoming only: whether the reference is a contract number pulled from Odoo (false: it is not, often a DO or
   * another paper). Null for an outgoing truck and for a truck without a reference.
   */
  contractKnown: boolean | null;
}

export type LegacyRow = Record<string, unknown>;

/** What the import kept of the old rows beyond the typed columns. Empty parts are left out. */
export interface LegacyTripDetails {
  flags?: LegacyRow;
  registration?: LegacyRow;
  weighing?: LegacyRow;
  otherWeighings?: LegacyRow[];
  qc?: LegacyRow;
  unloading?: LegacyRow;
  loading?: LegacyRow;
  seals?: string[];
  splits?: LegacyRow[];
  older?: { qc?: LegacyRow[]; unloading?: LegacyRow[]; loading?: LegacyRow[] };
  /** Original text per "table.column" of a value that was rounded or could not be read. */
  original?: Record<string, string>;
}

export interface LegacyException {
  id: number;
  site: string;
  /** APPROVAL: a request with the BA it led to; REPORT: a BA without a request. */
  source: "APPROVAL" | "REPORT";
  legacyId: number;
  legacyRegId: number | null;
  type: string | null;
  status: string | null;
  decision: string | null;
  ticketNo: string | null;
  plateText: string | null;
  driverName: string | null;
  transporter: string | null;
  reference: string | null;
  docGrossKg: number | null;
  weighedGrossKg: number | null;
  weighedTareKg: number | null;
  weighedNetKg: number | null;
  diffKg: number | null;
  diffPct: number | null;
  tolerancePct: number | null;
  requestedAt: string | null;
  respondedAt: string | null;
  respondedBy: string | null;
  reportNo: string | null;
  reportAt: string | null;
  reportBy: string | null;
  details: { approval?: LegacyRow; report?: LegacyRow; original?: Record<string, string> };
}

/** GET /api/history/trips/:id */
export interface LegacyTripDetail {
  trip: LegacyTrip & { importedAt: string; updatedAt: string; details: LegacyTripDetails };
  group: LegacyTrip[];
  exceptions: LegacyException[];
}

/** Totals over every matching row: a multi-contract group counts as one truck; the net counts finished trucks. */
export interface LegacyHistoryTotals {
  trucks: number;
  completedTrucks: number;
  netKg: number;
}

const STATES: Record<string, StatusInfo> = {
  COMPLETED: { label: "Selesai", tone: "success" },
  REJECTED_QC: { label: "Ditolak QC", tone: "destructive" },
  REJECTED_CLEANLINESS: { label: "Ditolak kebersihan", tone: "destructive" },
  UNFINISHED: { label: "Tidak selesai", tone: "neutral" },
};

export const HISTORY_STATES: ReadonlyArray<{ value: LegacyState; label: string }> = (Object.keys(STATES) as LegacyState[]).map((value) => ({
  value,
  label: STATES[value]?.label ?? value,
}));

export function historyStateInfo(state: string): StatusInfo {
  return STATES[state] ?? { label: state, tone: "neutral" };
}

export const HISTORY_DIRECTIONS: ReadonlyArray<{ value: LegacyDirection; label: string }> = [
  { value: "IN", label: "Incoming" },
  { value: "OUT", label: "Outgoing" },
  { value: "UNKNOWN", label: "Tidak tercatat" },
];

/** Sites of the old rows (signature); UNKNOWN when the old row had none (apps/api migrations/0010). */
export const HISTORY_SITES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "SMK", label: "SMK" },
  { value: "SBY", label: "SBY" },
  { value: "UNKNOWN", label: "Tanpa cabang" },
];

/** The contract filter of the page: `contract=missing` keeps the incoming trucks whose reference is no Odoo contract. */
export const HISTORY_CONTRACT_FILTERS: ReadonlyArray<{ value: string; label: string }> = [{ value: "missing", label: "Tanpa kontrak di Odoo" }];

/** Shown next to and under a reference that is not in the Odoo contract list. */
export const NO_CONTRACT_TITLE = "Nomor ini tidak ada di daftar kontrak Odoo. Ditampilkan seperti tercatat di aplikasi lama.";
export const NO_CONTRACT_NOTE = "Nomor ini tidak ada di daftar kontrak Odoo. Bisa jadi nomor DO atau dokumen lain.";

/** True only when the API says the reference is not a contract pulled from Odoo. */
export function withoutContract(trip: Pick<LegacyTrip, "contractKnown">): boolean {
  return trip.contractKnown === false;
}

/** What the reference of a truck is called: a DO going out, a contract coming in, or only a reference number. */
export function referenceLabel(trip: Pick<LegacyTrip, "direction" | "contractKnown">): "DO" | "Kontrak" | "Nomor acuan" {
  if (trip.direction === "OUT") return "DO";
  return withoutContract(trip) ? "Nomor acuan" : "Kontrak";
}

export const MATERIAL_LABELS: Readonly<Record<string, string>> = {
  CPO: "CPO",
  IN_GOODS: "Barang masuk lain",
  OUT_BULK: "Curah keluar",
  OUT_PACKED: "Kemasan keluar",
};

/** The default period of the page: the last 30 days, today included. Dates are YYYY-MM-DD of the plant. */
export function historyPeriod(today: string): { from: string; to: string } {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 29);
  return { from: day.toISOString().slice(0, 10), to: today };
}

/** Typed columns of a trip and the old "table.column" whose text the import keeps when it could not read it. */
const ORIGINAL_OF = {
  entryDate: "registrasi.tgl_entry",
  arrivedAt: "registrasi.tgl_masuk_truk",
  leftAt: "registrasi.tgl_keluar_truk",
  docGrossKg: "registrasi.bruto_from",
  docTareKg: "registrasi.tarra_from",
  docNetKg: "registrasi.netto_from",
  grossKg: "timbangan.bruto",
  tareKg: "timbangan.tarra",
  netKg: "timbangan.netto",
  weigh1At: "timbangan.tgl_timbang1",
  weigh2At: "timbangan.tgl_timbang2",
} as const;

export type ParsedTripField = keyof typeof ORIGINAL_OF;

/**
 * A typed value of a trip, or the original text when the import could not read it (the value is then null).
 * A rounded weight keeps its rounded value.
 */
export function tripValue<K extends ParsedTripField>(
  trip: LegacyTrip,
  field: K,
  original: Record<string, string> | undefined,
): { value: LegacyTrip[K]; original: string | null } {
  const value = trip[field];
  if (value !== null) return { value, original: null };
  return { value, original: original?.[ORIGINAL_OF[field]] ?? null };
}

/** The same for an exception, whose columns come from selisih_approval (request) or selisih (BA). */
export function exceptionOriginal(exception: LegacyException, column: string): string | null {
  const original = exception.details.original ?? {};
  return original[`selisih_approval.${column}`] ?? original[`selisih.${column}`] ?? null;
}

export interface LegacyField {
  key: string;
  label: string;
  value: string;
  /** False when the label is the old column name. */
  known: boolean;
}

/** Text of an old value; null when it is empty. */
function valueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "boolean") return value ? "ya" : "tidak";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/**
 * The filled columns of an old row: the labelled ones in the order of `labels`, then the others under their old
 * column name. The old row id and the columns in `skip` are left out.
 */
export function legacyFields(row: LegacyRow | null | undefined, labels: Readonly<Record<string, string>>, skip: readonly string[] = []): LegacyField[] {
  if (!row) return [];
  const left = new Set(["id", ...skip]);
  const known: LegacyField[] = [];
  for (const [key, label] of Object.entries(labels)) {
    if (left.has(key)) continue;
    const value = valueText(row[key]);
    if (value !== null) known.push({ key, label, value, known: true });
  }
  const others: LegacyField[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (left.has(key) || key in labels) continue;
    const value = valueText(raw);
    if (value !== null) others.push({ key, label: key, value, known: false });
  }
  return [...known, ...others];
}

// Labels of the old columns, from the old truck history page (inl_register truck_history.blade.php) and the
// mobile API that filled these tables. Columns not named here are shown under their old name.

export const QC_LABELS: Readonly<Record<string, string>> = {
  ffa: "FFA",
  mni: "M&I",
  moist: "Kadar air",
  imp: "Kotoran",
  impurities: "Kotoran",
  iv: "IV",
  melting_point: "Titik leleh",
  disposisi: "Disposisi",
  qcpass_usr: "Petugas QC",
  qcpass_tgl: "Waktu QC",
  approve: "Persetujuan",
  approve_usr: "Disetujui oleh",
  approve_tgl: "Waktu persetujuan",
  remark: "Catatan",
  remark_approve: "Catatan persetujuan",
  no_surat_out_spec: "Nomor surat out spec",
};

export const UNLOADING_LABELS: Readonly<Record<string, string>> = {
  trf: "Kode tangki",
  trf_name: "Tangki",
  no_pintu: "Nomor pintu",
  no_urut: "Nomor urut",
  cek_tanki: "Cek tangki",
  cek_tanki_usr: "Cek tangki oleh",
  cek_tanki_tgl: "Waktu cek tangki",
  pic_op: "PIC operator",
  pic_spv: "PIC supervisor",
  sertifikat: "Sertifikat",
  ket_sertifikat: "Keterangan sertifikat",
  unloading_usr: "Petugas bongkar",
  unloading_tgl: "Waktu bongkar",
  tgl_entry: "Tanggal entry",
};

export const LOADING_LABELS: Readonly<Record<string, string>> = {
  nama_tangki: "Tangki",
  no_tangki: "Nomor tangki",
  no_tanki: "Nomor tangki",
  time_start: "Mulai muat",
  time_stop: "Selesai muat",
  temp: "Suhu",
  ffa: "FFA",
  mni: "M&I",
  no_surat_coa: "Nomor COA",
  no_surat_jalan: "Nomor surat jalan",
  cek_kendaraan_bersih: "Kendaraan bersih",
  cek_genangan_cairan: "Genangan cairan",
  cek_disposisi: "Disposisi cek",
  cek_usr: "Dicek oleh",
  cek_tgl: "Waktu cek",
  qc_usr: "Petugas QC",
  qc_tgl: "Waktu QC",
  loading_usr: "Petugas muat",
  loading_tgl: "Waktu muat",
  tangki_bland_nama: "Tangki blending",
  tangki_bland_qty: "Jumlah blending",
  status_bland: "Status blending",
  remark_load: "Catatan muat",
  tgl_entry: "Tanggal entry",
};

const SEAL_LABELS: Readonly<Record<string, string>> = {
  segel_usr: "Dipasang oleh",
  segel_tgl: "Waktu pasang",
  remark_segel: "Catatan segel",
  segel1_reject: "Segel ditolak",
  segel2_reject: "Segel ditolak kedua",
  segel_reject_usr: "Ditolak oleh",
  segel_reject_tgl: "Waktu ditolak",
  cek_segel: "Cek segel",
  cek_segel_usr: "Cek segel oleh",
  cek_segel_tgl: "Waktu cek segel",
};

/** Seal columns of the loading and unloading sheets; they are shown with the seals, not on the sheets. */
export const SEAL_COLUMNS: readonly string[] = ["segel1", "segel2", "segel3", "segel4", ...Object.keys(SEAL_LABELS)];

/** The seal numbers of a truck and what the sheets say about them. */
export function sealFacts(details: Pick<LegacyTripDetails, "seals" | "loading" | "unloading">): { numbers: string[]; fields: LegacyField[] } {
  const pick = (row: LegacyRow | undefined) => (row ? legacyFields(Object.fromEntries(Object.entries(row).filter(([key]) => key in SEAL_LABELS)), SEAL_LABELS) : []);
  return { numbers: details.seals ?? [], fields: [...pick(details.loading), ...pick(details.unloading)] };
}

const EXCEPTION_TYPES: Record<string, string> = {
  BRUTO_IN: "Selisih bruto masuk",
  NETTO_IN: "Selisih netto masuk",
  NETTO_OUT: "Selisih netto keluar",
  TARRA_OUT: "Selisih tarra keluar",
  PLAT: "Plat tidak cocok",
};

/** A request without a type is a deviation report (BA) on its own. */
export function exceptionTypeLabel(type: string | null): string {
  if (!type) return "Berita acara selisih";
  return EXCEPTION_TYPES[type.toUpperCase()] ?? type;
}

const EXCEPTION_STATUSES: Record<string, string> = {
  PENDING: "Menunggu",
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  RETRY: "Timbang ulang",
  CANCELLED: "Dibatalkan",
  EXPIRED: "Kedaluwarsa",
};

export function exceptionStatusLabel(status: string | null): string | null {
  if (!status) return null;
  return EXCEPTION_STATUSES[status.toUpperCase()] ?? status;
}

/** The rows of a multi-contract truck, this one first in legacy id order, with the sum of their known net. */
export function groupShares(
  trip: LegacyTrip,
  group: readonly LegacyTrip[],
): { rows: { trip: LegacyTrip; current: boolean }[]; totalNetKg: number } | null {
  if (trip.groupId === null) return null;
  const rows = [{ trip, current: true }, ...group.map((member) => ({ trip: member, current: false }))].sort((a, b) => a.trip.legacyId - b.trip.legacyId);
  return { rows, totalNetKg: rows.reduce((sum, row) => sum + (row.trip.netKg ?? 0), 0) };
}
