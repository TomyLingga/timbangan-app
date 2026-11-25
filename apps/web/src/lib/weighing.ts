// Words and figures for the weighing phase: request types, step states, the
// difference of a request, how long it has waited. Values the API adds later
// are shown as received rather than mislabelled.

import type { StatusInfo } from "@/lib/status";
import type { ExceptionStatus, ExceptionType, ExceptionView, StationKind, StepStatus } from "@/lib/types";

export const EXCEPTION_TYPE_LABELS: Readonly<Record<ExceptionType, string>> = {
  PLATE: "Plat tidak cocok",
  GROSS_IN: "Selisih bruto",
  TARE_OUT: "Selisih tarra",
  NET_IN: "Selisih netto",
  NET_OUT: "Cek netto outgoing",
  QC_HOLD: "Tahan QC",
};

export function exceptionTypeLabel(type: string): string {
  return EXCEPTION_TYPE_LABELS[type as ExceptionType] ?? type;
}

const EXCEPTION_STATUS: Readonly<Record<ExceptionStatus, StatusInfo>> = {
  PENDING: { label: "Menunggu", tone: "warning" },
  APPROVED: { label: "Disetujui", tone: "success" },
  REJECTED: { label: "Ditolak", tone: "destructive" },
  RETRY: { label: "Diulang", tone: "neutral" },
  CANCELLED: { label: "Batal", tone: "neutral" },
  EXPIRED: { label: "Kedaluwarsa", tone: "neutral" },
};

export function exceptionStatusInfo(status: string): StatusInfo {
  return EXCEPTION_STATUS[status as ExceptionStatus] ?? { label: status, tone: "neutral" };
}

/** The decision as words: what was chosen on a decided request. */
export function decisionLabel(decision: string | null): string | null {
  if (!decision) return null;
  return { APPROVE: "Disetujui", HOLD: "Mundur/hold", REJECT: "Ditolak", OK: "Sesuai", ADD_LOAD: "Isi lagi", REDUCE_LOAD: "Kurangi isi" }[decision] ?? decision;
}

/** The three weight differences: a written reason is required and an approval gets a Berita Acara. */
export const DIFFERENCE_TYPES: readonly string[] = ["GROSS_IN", "TARE_OUT", "NET_IN"];

/** A reason is required for the three weight differences, and to turn a truck away (decide.ts). */
export function needsReason(type: string, decision: string | null = null): boolean {
  return DIFFERENCE_TYPES.includes(type) || (decision === "REJECT" && type !== "QC_HOLD");
}

/** What a request offers when the server did not say: the same rules as allowedDecisions in the API. */
export function decisionOptions(view: { type: string; stage: number | null; options?: string[] }): string[] {
  if (view.options && view.options.length > 0) return view.options;
  if (view.type === "NET_OUT") return ["OK", "ADD_LOAD", "REDUCE_LOAD"];
  if (view.type === "QC_HOLD") return ["APPROVE", "REJECT"];
  if (view.type === "NET_IN" || view.stage === 2) return ["APPROVE", "HOLD"];
  return ["APPROVE", "HOLD", "REJECT"];
}

/** What the request compares, for its figures: the letter, the master tare, or nothing (plate). */
export function referenceLabel(type: string): string {
  if (type === "TARE_OUT") return "Tarra master";
  if (type === "NET_OUT") return "Rencana";
  return "Surat";
}

/** Whether the difference goes past the tolerance (the API's rule: |acuan - timbang| / acuan > persen / 100). */
export function overTolerance(view: Pick<ExceptionView, "diffPct" | "tolerancePct">): boolean {
  if (view.diffPct === null || view.tolerancePct === null) return false;
  return Math.abs(view.diffPct) > view.tolerancePct;
}

/** "3 mnt", "1 jam 5 mnt", "baru saja": how long a request has been waiting. */
export function waitedFor(sinceIso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  if (seconds < 45) return "baru saja";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} jam ${rest} mnt` : `${hours} jam`;
}

/** Plates compared as the API compares them: upper case, no spaces. */
export function samePlate(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (value: string) => value.toUpperCase().replace(/\s+/g, "");
  return norm(a) === norm(b);
}

const STEP_STATUS: Readonly<Record<StepStatus, StatusInfo>> = {
  PENDING: { label: "Belum", tone: "neutral" },
  READY: { label: "Siap", tone: "warning" },
  IN_PROGRESS: { label: "Dikerjakan", tone: "warning" },
  DONE: { label: "Selesai", tone: "success" },
  SKIPPED: { label: "Dilewati", tone: "neutral" },
  FAILED: { label: "Ditolak", tone: "destructive" },
};

export function stepStatusInfo(status: string): StatusInfo {
  return STEP_STATUS[status as StepStatus] ?? { label: status, tone: "neutral" };
}

export const STATION_KIND_LABELS: Readonly<Record<StationKind, string>> = {
  REGISTRATION: "Pendaftaran",
  GATE: "Pos registrasi",
  WEIGHBRIDGE: "Timbangan",
  QC: "QC",
  STAGING: "Area tunggu",
  UNLOADING_BAY: "Tempat bongkar",
  LOADING_BAY: "Tempat muat",
  DOCK: "Dok",
  SEALING: "Segel",
};

export function stationKindLabel(kind: string): string {
  return STATION_KIND_LABELS[kind as StationKind] ?? kind;
}

/** "Bruto" or "Tarra" with the stage: what a weighing measured. */
export function weighingLabel(stage: number, kind: string): string {
  return `Timbang ${stage} (${kind === "GROSS" ? "bruto" : kind === "TARE" ? "tarra" : kind})`;
}

export function plateCheckLabel(check: string): string {
  return { MATCH: "Plat cocok", CONFIRMED: "Plat dikonfirmasi", BYPASSED: "Plat dilewati" }[check] ?? check;
}

export function weighingModeLabel(mode: string): string {
  return { AUTO: "Otomatis", EXCEPTION: "Lewat keputusan" }[mode] ?? mode;
}
