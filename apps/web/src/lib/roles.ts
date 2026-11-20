import type { User } from "@/lib/types";

/** Role codes as the API sends them, with the label shown to users. */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  SUPER_ADMIN: "Admin sistem",
  LOGISTICS_ADMIN: "Admin logistik",
  REGISTRATION_OPERATOR: "Pos registrasi",
  LOGISTICS_SUPERVISOR: "Atasan logistik",
  QC_OPERATOR: "QC",
  QC_SUPERVISOR: "Supervisor QC",
  SECURITY: "Security",
  UNLOADING_OPERATOR: "Bongkar",
  LOADING_OPERATOR: "Muat",
  SEAL_OPERATOR: "Segel",
  MANAGEMENT: "Manajemen",
  PARTNER_SUPPLIER: "PKS / supplier",
  PARTNER_TRANSPORTER: "Transporter",
  PARTNER_CUSTOMER: "Customer",
};

/** Roles allowed to start an Odoo sync (POST /api/admin/sync/odoo). */
const SYNC_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "LOGISTICS_ADMIN"]);

/** An unknown code is shown as it is, so a new role is still visible. */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function roleLabels(roles: readonly string[]): string[] {
  return [...new Set(roles)].map(roleLabel);
}

export function canSyncOdoo(user: User | null | undefined): boolean {
  return !!user && user.roles.some((role) => SYNC_ROLES.has(role));
}

export function isStaff(user: User | null | undefined): boolean {
  return user?.kind === "INTERNAL";
}

/** A staff account that signed in through the portal but has no role yet. */
export function awaitsRoleAssignment(user: User | null | undefined): boolean {
  return !!user && user.kind === "INTERNAL" && user.roles.length === 0;
}
