import type { SyncRun } from "@/lib/types";

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
};

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
