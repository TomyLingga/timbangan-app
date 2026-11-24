// Access per module, as the API checks it (apps/api src/auth/guard.ts and the
// route table in test/route-permissions.test.ts). A button shows only when the
// route behind it would let the account through; the API stays the judge.

import type { ModuleCode, ModuleDefinition, PermissionLevel, Permissions, User, UserKind } from "@/lib/types";

type MaybeUser = User | null | undefined;

const RANK: Record<PermissionLevel, number> = { VIEW: 1, CREATE: 2, EDIT: 3 };

/** Labels for the modules of this phase, used when the module list has not been loaded. */
export const MODULE_LABELS: Readonly<Record<ModuleCode, string>> = {
  contracts: "Kontrak",
  drivers: "Supir",
  vehicles: "Kendaraan",
  delivery_orders: "Delivery Order",
  registrations: "Registrasi",
  gate: "Pos registrasi",
  rfid_cards: "Kartu RFID",
  users: "Pengguna dan hak akses",
  weighbridge: "Timbangan",
  approvals: "Keputusan selisih dan plat",
  qc: "QC",
  qc_approvals: "Keputusan QC",
  security_check: "Pemeriksaan security",
  unloading: "Bongkar",
  loading: "Muat",
  sealing: "Segel",
  reports: "Laporan",
  plant_masters: "Master pabrik",
  dashboard: "Dashboard",
  gps: "Lacak kendaraan",
};

export const LEVEL_LABELS: Readonly<Record<PermissionLevel, string>> = {
  VIEW: "Lihat",
  CREATE: "Lihat dan buat",
  EDIT: "Lihat, buat, dan ubah",
};

const SHORT_LEVEL: Readonly<Record<PermissionLevel, string>> = { VIEW: "lihat", CREATE: "buat", EDIT: "ubah" };

function covers(held: PermissionLevel | undefined, needed: PermissionLevel): boolean {
  return held !== undefined && RANK[held] !== undefined && RANK[held] >= RANK[needed];
}

export function canView(user: MaybeUser, area: ModuleCode): boolean {
  return !!user && covers(user.permissions[area], "VIEW");
}

export function canCreate(user: MaybeUser, area: ModuleCode): boolean {
  return !!user && covers(user.permissions[area], "CREATE");
}

export function canEdit(user: MaybeUser, area: ModuleCode): boolean {
  return !!user && covers(user.permissions[area], "EDIT");
}

export function isStaff(user: MaybeUser): boolean {
  return user?.kind === "INTERNAL";
}

/** A staff account without any permission: the API answers NO_ACCESS everywhere. */
export function awaitsAccess(user: MaybeUser): boolean {
  return !!user && user.kind === "INTERNAL" && Object.keys(user.permissions).length === 0;
}

// --- master data ----------------------------------------------------------------

/** POST /api/admin/sync/odoo: contracts EDIT, staff only. */
export const canSyncOdoo = (user: MaybeUser) => isStaff(user) && canEdit(user, "contracts");
/** GET /api/admin/sync/runs: contracts or drivers VIEW, staff only. */
export const canSeeSyncRuns = (user: MaybeUser) => isStaff(user) && (canView(user, "contracts") || canView(user, "drivers"));
/** GET /api/drivers is staff only. */
export const canSeeDrivers = (user: MaybeUser) => isStaff(user) && canView(user, "drivers");
export const canAddDriver = (user: MaybeUser) => isStaff(user) && canCreate(user, "drivers");
export const canSyncVcf = (user: MaybeUser) => isStaff(user) && canEdit(user, "drivers");
export const canAddVehicle = (user: MaybeUser) => isStaff(user) && canCreate(user, "vehicles");
export const canEditVehicle = (user: MaybeUser) => isStaff(user) && canEdit(user, "vehicles");

// --- delivery orders ------------------------------------------------------------

/** A partner account never writes a DO, whatever its level. */
export const canCreateDeliveryOrder = (user: MaybeUser) => isStaff(user) && canCreate(user, "delivery_orders");
/** Change, send, close and cancel. */
export const canManageDeliveryOrders = (user: MaybeUser) => isStaff(user) && canEdit(user, "delivery_orders");
/** The transporter accepts a DO sent to its company; staff accept any. */
export const canAcceptDeliveryOrder = (user: MaybeUser) => canEdit(user, "delivery_orders");

// --- registrations ----------------------------------------------------------------

/** registrations CREATE, and for a partner account its company must be a supplier. */
export function canCreateIncoming(user: MaybeUser): boolean {
  return canCreate(user, "registrations") && (isStaff(user) || user?.partner?.isSupplier === true);
}

/** registrations CREATE, and for a partner account its company must be a transporter. */
export function canCreateOutgoing(user: MaybeUser): boolean {
  return canCreate(user, "registrations") && (isStaff(user) || user?.partner?.isTransporter === true);
}

/** Approve and reject: registrations EDIT, never a partner account. */
export const canReviewRegistrations = (user: MaybeUser) => isStaff(user) && canEdit(user, "registrations");

/**
 * POST /api/registrations/:id/cancel: registrations CREATE; staff without EDIT
 * only for registrations they made. A partner reaches only its own.
 */
export function canCancelRegistration(user: MaybeUser, registration: { createdBy: { id: string | number } | null }): boolean {
  if (!user || !canCreate(user, "registrations")) return false;
  if (user.kind === "PARTNER" || canEdit(user, "registrations")) return true;
  return String(registration.createdBy?.id) === String(user.id);
}

/** PUT /api/registrations/:id and submit: a draft, in a direction the account may write. */
export function canEditDraft(user: MaybeUser, registration: { status: string; direction: "IN" | "OUT" }): boolean {
  if (registration.status.toUpperCase() !== "DRAFT") return false;
  return registration.direction === "IN" ? canCreateIncoming(user) : canCreateOutgoing(user);
}

// --- phase 4 ----------------------------------------------------------------------

/** GET, POST and PATCH /api/stations and the machine key: weighbridge EDIT, staff only. */
export const canManageStations = (user: MaybeUser) => isStaff(user) && canEdit(user, "weighbridge");
/** GET /api/exceptions: approvals VIEW, staff only. */
export const canSeeApprovals = (user: MaybeUser) => isStaff(user) && canView(user, "approvals");
/** POST /api/exceptions/:id/decide: approvals EDIT (the API also checks the module of each request). */
export const canDecide = (user: MaybeUser) => isStaff(user) && canEdit(user, "approvals");
/** GET /api/reports/*: reports VIEW, staff only. */
export const canSeeReports = (user: MaybeUser) => isStaff(user) && canView(user, "reports");
/** GET /api/trips/:id/steps: any staff account. */
export const canSeeTripWork = (user: MaybeUser) => isStaff(user);
/** POST /api/trips/:id/steps/:code/complete: the module of the step at level create. */
export const canCompleteStep = (user: MaybeUser, performerModule: string | null) =>
  isStaff(user) && performerModule !== null && canCreate(user, performerModule as ModuleCode);
/** POST /api/gate/check-out: gate CREATE. */
export const canCheckOut = (user: MaybeUser) => canCreate(user, "gate");

/** POST /api/trips/:id/spj/reissue: gate EDIT. */
export const canReissueSpj = (user: MaybeUser) => canEdit(user, "gate");

// --- plant masters (tanks and seals) ------------------------------------------------

/** GET /api/tanks and /api/seals: plant_masters VIEW, staff only. */
export const canSeePlantMasters = (user: MaybeUser) => isStaff(user) && canView(user, "plant_masters");
/** PATCH /api/tanks/:id (a tank from Odoo: only isActive): plant_masters EDIT. */
export const canToggleTanks = (user: MaybeUser) => isStaff(user) && canEdit(user, "plant_masters");
/** POST /api/seals/batch: plant_masters CREATE. */
export const canAddSeals = (user: MaybeUser) => isStaff(user) && canCreate(user, "plant_masters");
/** PATCH /api/seals/:id to VOID: plant_masters EDIT. */
export const canVoidSeals = (user: MaybeUser) => isStaff(user) && canEdit(user, "plant_masters");

// --- GPS (phase 8) ----------------------------------------------------------------------

/** GET /api/gps/vehicles and the tracks: gps VIEW, staff and partner accounts (the API decides which trucks). */
export const canTrackVehicles = (user: MaybeUser) => canView(user, "gps");
/** Sources, trackers, settings and share links: gps EDIT, staff only. */
export const canManageGps = (user: MaybeUser) => isStaff(user) && canEdit(user, "gps");

// --- user administration --------------------------------------------------------------

/** The modules an account of this kind can be given: partner accounts only the partner-allowed ones. */
export function modulesForKind(modules: readonly ModuleDefinition[], kind: UserKind): ModuleDefinition[] {
  return kind === "PARTNER" ? modules.filter((item) => item.partnerAllowed) : [...modules];
}

/** Choices for one module: no access, then each level the module has. */
export function levelChoices(item: ModuleDefinition): Array<{ value: "" | PermissionLevel; label: string }> {
  const levels = (["VIEW", "CREATE", "EDIT"] as const).filter((level) => item.levels.includes(level));
  return [{ value: "", label: "Tidak ada akses" }, ...levels.map((level) => ({ value: level, label: LEVEL_LABELS[level] }))];
}

const topLevel = (item: ModuleDefinition): PermissionLevel | null =>
  (["EDIT", "CREATE", "VIEW"] as const).find((level) => item.levels.includes(level)) ?? null;

/** The highest level of every module the account may get. */
export function grantAll(modules: readonly ModuleDefinition[], kind: UserKind): Permissions {
  const granted: Permissions = {};
  for (const item of modulesForKind(modules, kind)) {
    const level = topLevel(item);
    if (level) granted[item.code] = level;
  }
  return granted;
}

export function setLevel(permissions: Permissions, code: string, level: PermissionLevel | null): Permissions {
  const next = { ...permissions };
  if (level) next[code] = level;
  else delete next[code];
  return next;
}

/**
 * Body of PUT /api/admin/users/:id/permissions. The API replaces every
 * permission, so each offered module is sent, null where there is no access.
 */
export function permissionsPayload(
  modules: readonly ModuleDefinition[],
  kind: UserKind,
  permissions: Permissions,
): Record<string, PermissionLevel | null> {
  return Object.fromEntries(modulesForKind(modules, kind).map((item) => [item.code, permissions[item.code] ?? null]));
}

/** "Kontrak: lihat · Supir: buat", or a short sentence for no access and full access. */
export function accessSummary(permissions: Permissions, modules: readonly ModuleDefinition[], kind: UserKind): string {
  const held = Object.entries(permissions).filter((entry): entry is [string, PermissionLevel] => entry[1] !== undefined);
  if (held.length === 0) return "Belum ada akses";
  const offered = modulesForKind(modules, kind);
  if (offered.length > 0 && offered.every((item) => permissions[item.code] === topLevel(item))) return "Semua modul, penuh";
  const order = (code: string) => {
    const at = modules.findIndex((item) => item.code === code);
    return at === -1 ? modules.length + Object.keys(MODULE_LABELS).indexOf(code) : at;
  };
  const label = (code: string) =>
    modules.find((item) => item.code === code)?.name ?? MODULE_LABELS[code as ModuleCode] ?? code;
  return held
    .sort(([a], [b]) => order(a) - order(b))
    .map(([code, level]) => `${label(code)}: ${SHORT_LEVEL[level] ?? level}`)
    .join(" · ");
}
