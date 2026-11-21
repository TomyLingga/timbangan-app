import type { Finding, GateCheck, SyncRun } from "@/lib/types";

// The API contract names the `state` and `status` fields but not their values.
// Known spellings get an Indonesian label; anything else is shown as received,
// so a value added on the server is visible instead of silently mislabelled.

export type Tone = "success" | "warning" | "destructive" | "neutral";

export interface StatusInfo {
  label: string;
  tone: Tone;
}

function lookup(table: Record<string, StatusInfo>, value: string): StatusInfo {
  const key = value.trim().toLowerCase();
  if (!key) return { label: "-", tone: "neutral" };
  return table[key] ?? { label: value, tone: "neutral" };
}

const ACTIVE: StatusInfo = { label: "Aktif", tone: "success" };
const CLOSED: StatusInfo = { label: "Tutup", tone: "neutral" };
const CANCELLED: StatusInfo = { label: "Batal", tone: "destructive" };

const CONTRACT_STATES: Record<string, StatusInfo> = {
  open: ACTIVE,
  active: ACTIVE,
  ongoing: ACTIVE,
  in_progress: ACTIVE,
  closed: CLOSED,
  close: CLOSED,
  done: CLOSED,
  expired: { label: "Kedaluwarsa", tone: "warning" },
  draft: { label: "Draf", tone: "neutral" },
  cancel: CANCELLED,
  cancelled: CANCELLED,
  canceled: CANCELLED,
};

export function contractStateInfo(state: string): StatusInfo {
  return lookup(CONTRACT_STATES, state);
}

const SYNC_OK: StatusInfo = { label: "Berhasil", tone: "success" };
const SYNC_FAILED: StatusInfo = { label: "Gagal", tone: "destructive" };
const SYNC_RUNNING: StatusInfo = { label: "Sedang berjalan", tone: "warning" };

const SYNC_STATUSES: Record<string, StatusInfo> = {
  success: SYNC_OK,
  succeeded: SYNC_OK,
  ok: SYNC_OK,
  done: SYNC_OK,
  completed: SYNC_OK,
  failed: SYNC_FAILED,
  failure: SYNC_FAILED,
  error: SYNC_FAILED,
  running: SYNC_RUNNING,
  started: SYNC_RUNNING,
  in_progress: SYNC_RUNNING,
};

export function syncStatusInfo(status: string): StatusInfo {
  return lookup(SYNC_STATUSES, status);
}

const SYNC_ENTITIES: Record<string, string> = {
  contract: "Kontrak",
  contracts: "Kontrak",
  partner: "Partner",
  partners: "Partner",
  product: "Barang",
  products: "Barang",
  driver: "Supir",
  drivers: "Supir",
  transporter: "Transporter",
  transporters: "Transporter",
};

/** Entities that come from the driver registry (VCF); the others come from Odoo. */
const VCF_ENTITIES: ReadonlySet<string> = new Set(["driver", "drivers", "transporter", "transporters"]);

export function runsBySource(runs: readonly SyncRun[]): { odoo: SyncRun[]; vcf: SyncRun[] } {
  const odoo: SyncRun[] = [];
  const vcf: SyncRun[] = [];
  for (const run of runs) {
    (VCF_ENTITIES.has(run.entity.trim().toLowerCase()) ? vcf : odoo).push(run);
  }
  return { odoo, vcf };
}

const NOT_IN_REGISTRY: StatusInfo = { label: "Belum ada di VCF", tone: "neutral" };

const REGISTRY_STATUSES: Record<string, StatusInfo> = {
  normal: { label: "Normal", tone: "success" },
  warning: { label: "Warning", tone: "warning" },
  blacklist: { label: "Blacklist", tone: "destructive" },
  unknown: NOT_IN_REGISTRY,
};

/** Status of a driver in the central driver registry (VCF). */
export function registryStatusInfo(status: string | null | undefined): StatusInfo {
  return status ? lookup(REGISTRY_STATUSES, status) : NOT_IN_REGISTRY;
}

const DOCUMENT_NAMES: Record<string, string> = { STNK: "STNK", TAX: "Pajak", KIR: "KIR" };
const DOCUMENT_ORDER = ["STNK", "TAX", "KIR"];

/** "Pajak lewat" for the code of an expired vehicle document. */
export function expiredDocumentLabel(code: string): string {
  return `${DOCUMENT_NAMES[code] ?? code} lewat`;
}

/** One line naming every expired document, or null when none is. */
export function expirySummary(expired: readonly string[] | null | undefined): string | null {
  if (!expired || expired.length === 0) return null;
  const rank = (code: string) => {
    const index = DOCUMENT_ORDER.indexOf(code);
    return index === -1 ? DOCUMENT_ORDER.length : index;
  };
  return [...expired]
    .sort((a, b) => rank(a) - rank(b))
    .map(expiredDocumentLabel)
    .join(", ");
}

// --- phase 3 ----------------------------------------------------------------

const DRAFT: StatusInfo = { label: "Draf", tone: "neutral" };
const AWAITING_REVIEW: StatusInfo = { label: "Menunggu tinjauan", tone: "warning" };

const DELIVERY_ORDER_STATUSES: Record<string, StatusInfo> = {
  draft: DRAFT,
  sent: { label: "Menunggu transporter", tone: "warning" },
  accepted: { label: "Diterima transporter", tone: "success" },
  closed: CLOSED,
  cancelled: CANCELLED,
};

export function deliveryOrderStatusInfo(status: string): StatusInfo {
  return lookup(DELIVERY_ORDER_STATUSES, status);
}

const REGISTRATION_STATUSES: Record<string, StatusInfo> = {
  draft: DRAFT,
  submitted: AWAITING_REVIEW,
  approved: { label: "Disetujui", tone: "success" },
  rejected: { label: "Ditolak", tone: "destructive" },
  cancelled: CANCELLED,
};

export function registrationStatusInfo(status: string): StatusInfo {
  return lookup(REGISTRATION_STATUSES, status);
}

const TRIP_STATUSES: Record<string, StatusInfo> = {
  draft: DRAFT,
  ready: AWAITING_REVIEW,
  issued: { label: "SPJ terbit", tone: "success" },
  checked_in: { label: "Sudah check-in", tone: "success" },
  in_process: { label: "Dalam proses", tone: "success" },
  completed: { label: "Selesai", tone: "neutral" },
  rejected: { label: "Ditolak", tone: "destructive" },
  cancelled: CANCELLED,
  expired: { label: "SPJ kedaluwarsa", tone: "destructive" },
};

export function tripStatusInfo(status: string): StatusInfo {
  return lookup(TRIP_STATUSES, status);
}

const CARD_STATUSES: Record<string, StatusInfo> = {
  available: { label: "Tersedia", tone: "success" },
  in_use: { label: "Dipakai truk", tone: "warning" },
  lost: { label: "Hilang", tone: "destructive" },
  retired: { label: "Tidak dipakai lagi", tone: "neutral" },
};

export function cardStatusInfo(status: string): StatusInfo {
  return lookup(CARD_STATUSES, status);
}

const SEAL_STATUSES: Record<string, StatusInfo> = {
  available: { label: "Tersedia", tone: "success" },
  used: { label: "Terpakai", tone: "neutral" },
  void: { label: "Batal", tone: "destructive" },
};

export function sealStatusInfo(status: string): StatusInfo {
  return lookup(SEAL_STATUSES, status);
}

/**
 * Findings of a registration and checks at the post share their codes. Each
 * known code gets a plain sentence; for an unknown one the server's text is
 * shown (these texts describe the truck, not the program), or the code.
 */
const CHECK_SENTENCES: Record<string, string> = {
  DRIVER_WARNING: "Supir berstatus Warning di VCF.",
  DRIVER_NOT_IN_REGISTRY: "Supir belum ada di VCF.",
  DRIVER_BLACKLISTED: "Supir masuk daftar hitam VCF.",
  DRIVER_BLOCKED: "Supir sedang diblokir di pabrik ini.",
  LICENCE_EXPIRED: "SIM supir sudah lewat masa berlaku.",
  VEHICLE_UNVERIFIED: "Kendaraan baru dan belum diverifikasi admin.",
  STNK_EXPIRED: "STNK kendaraan sudah lewat masa berlaku.",
  TAX_EXPIRED: "Pajak kendaraan sudah lewat masa berlaku.",
  KIR_EXPIRED: "KIR kendaraan sudah lewat masa berlaku.",
  OVER_CONTRACT: "Netto surat melebihi sisa kontrak.",
  OVER_DO: "Rencana quantity melebihi sisa DO.",
  OVER_CAPACITY: "Rencana muatan melebihi daya angkut kendaraan.",
  OUTSIDE_DELIVERY_WINDOW: "Tanggal datang di luar masa kirim DO.",
  SPJ_EXPIRED: "Masa berlaku SPJ sudah lewat.",
  SPJ_REVOKED: "SPJ ini sudah dicabut.",
  ALREADY_CHECKED_IN: "Truk ini sudah check-in.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik.",
};

export function checkSentence(check: { code: string; message: string }): string {
  return CHECK_SENTENCES[check.code] ?? (check.message?.trim() || check.code);
}

/** "Truk 2, alokasi 1": what a finding points at, or null when it is about the whole registration. */
export function findingWhere(finding: Pick<Finding, "tripSeq" | "allocationSeq"> & { code?: string; message?: string | null }): string | null {
  const parts: string[] = [];
  if (finding.tripSeq !== null && finding.tripSeq !== undefined) parts.push(`Truk ${finding.tripSeq}`);
  if (finding.allocationSeq !== null && finding.allocationSeq !== undefined) {
    parts.push(parts.length > 0 ? `alokasi ${finding.allocationSeq}` : `Alokasi ${finding.allocationSeq}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function isBlocking(check: GateCheck): boolean {
  return check.level === "BLOCK";
}

export function syncEntityLabel(entity: string): string {
  return SYNC_ENTITIES[entity.trim().toLowerCase()] ?? entity;
}

function startedTime(run: SyncRun): number {
  const time = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** One sync writes a run per entity. Returns the newest run of each, newest first. */
export function latestRunPerEntity(runs: readonly SyncRun[]): SyncRun[] {
  const newestFirst = [...runs].sort((a, b) => startedTime(b) - startedTime(a));
  const seen = new Set<string>();
  const latest: SyncRun[] = [];
  for (const run of newestFirst) {
    const key = run.entity.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(run);
  }
  return latest;
}
