// Access per module as the API checks it (apps/api/src/auth/permissions.ts, apps/web/src/lib/permissions.ts):
// VIEW < CREATE < EDIT, a higher level includes the lower ones. The API stays the judge.

import type { Account, PermissionLevel } from "../api/types";

const RANK: Record<PermissionLevel, number> = { VIEW: 1, CREATE: 2, EDIT: 3 };

type MaybeAccount = Account | null | undefined;

export function covers(held: PermissionLevel | undefined, needed: PermissionLevel): boolean {
  return held !== undefined && RANK[held] !== undefined && RANK[held] >= RANK[needed];
}

export const canView = (user: MaybeAccount, module: string) => !!user && covers(user.permissions[module], "VIEW");
export const canCreate = (user: MaybeAccount, module: string) => !!user && covers(user.permissions[module], "CREATE");
export const canEdit = (user: MaybeAccount, module: string) => !!user && covers(user.permissions[module], "EDIT");

/** The modules whose steps are done on the phone, in the order of a truck's way through the plant. */
export const FIELD_MODULES = ["security_check", "qc", "unloading", "loading", "sealing"] as const;
export type FieldModule = (typeof FIELD_MODULES)[number];

export const MODULE_LABELS: Record<string, string> = {
  security_check: "Security",
  qc: "QC",
  unloading: "Bongkar",
  loading: "Muat",
  sealing: "Segel",
  approvals: "Keputusan selisih",
  qc_approvals: "Keputusan QC",
};

export const LEVEL_LABELS: Record<PermissionLevel, string> = { VIEW: "lihat", CREATE: "isi", EDIT: "isi dan ubah" };

/** Field modules the account may see (the API lists their steps for VIEW). */
export const fieldModulesOf = (user: MaybeAccount): FieldModule[] => FIELD_MODULES.filter((module) => canView(user, module));

/** Sending a form needs the step's module at CREATE (apps/api/src/work/engine.ts). */
export const canSendForm = (user: MaybeAccount, module: string | null) =>
  module !== null && user?.kind === "INTERNAL" && canCreate(user, module);

/** The decision modules: weighbridge requests (approvals) and QC holds (qc_approvals). */
export const DECISION_MODULES = ["approvals", "qc_approvals"] as const;
export const seesDecisions = (user: MaybeAccount) => user?.kind === "INTERNAL" && DECISION_MODULES.some((module) => canView(user, module));
/** Deciding needs the request's module at EDIT (apps/api/src/exceptions/decide.ts). */
export const canDecide = (user: MaybeAccount, approverModule: string) => user?.kind === "INTERNAL" && canEdit(user, approverModule);
