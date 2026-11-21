import type { RoleDefinition, User, UserKind } from "@/lib/types";

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

/** Roles that may add drivers and add or change vehicles. */
const MASTER_WRITE_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "LOGISTICS_ADMIN", "REGISTRATION_OPERATOR"]);

function hasAny(user: User | null | undefined, roles: ReadonlySet<string>): boolean {
  return !!user && user.roles.some((role) => roles.has(role));
}

export function canWriteDrivers(user: User | null | undefined): boolean {
  return hasAny(user, MASTER_WRITE_ROLES);
}

export function canWriteVehicles(user: User | null | undefined): boolean {
  return hasAny(user, MASTER_WRITE_ROLES);
}

/** Starting a sync from the driver registry (POST /api/admin/sync/vcf). */
export function canSyncVcf(user: User | null | undefined): boolean {
  return hasAny(user, SYNC_ROLES);
}

export function canWriteDestinations(user: User | null | undefined): boolean {
  return hasAny(user, SYNC_ROLES);
}

/** The user administration page is for the system admin alone. */
export function canManageUsers(user: User | null | undefined): boolean {
  return !!user && user.roles.includes("SUPER_ADMIN");
}

// --- phase 3: registrations, delivery orders, the post, RFID cards ----------

const ADMIN_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "LOGISTICS_ADMIN"]);
/** Staff who may register a truck on behalf of a partner (created_via OPERATOR). */
const REGISTERING_STAFF: ReadonlySet<string> = new Set(["SUPER_ADMIN", "LOGISTICS_ADMIN", "REGISTRATION_OPERATOR"]);
const SUPPLIER: ReadonlySet<string> = new Set(["PARTNER_SUPPLIER"]);
const TRANSPORTER: ReadonlySet<string> = new Set(["PARTNER_TRANSPORTER"]);

export function isTransporterAccount(user: User | null | undefined): boolean {
  return user?.kind === "PARTNER" && hasAny(user, TRANSPORTER);
}

export function canSeeRegistrations(user: User | null | undefined): boolean {
  return hasAny(user, REGISTERING_STAFF) || hasAny(user, SUPPLIER) || hasAny(user, TRANSPORTER);
}

export function canCreateIncoming(user: User | null | undefined): boolean {
  return hasAny(user, REGISTERING_STAFF) || hasAny(user, SUPPLIER);
}

export function canCreateOutgoing(user: User | null | undefined): boolean {
  return hasAny(user, REGISTERING_STAFF) || hasAny(user, TRANSPORTER);
}

export function canReviewRegistrations(user: User | null | undefined): boolean {
  return hasAny(user, ADMIN_ROLES);
}

export function canSeeDeliveryOrders(user: User | null | undefined): boolean {
  return hasAny(user, ADMIN_ROLES) || hasAny(user, TRANSPORTER);
}

export function canManageDeliveryOrders(user: User | null | undefined): boolean {
  return hasAny(user, ADMIN_ROLES);
}

export function canUseGate(user: User | null | undefined): boolean {
  return hasAny(user, REGISTERING_STAFF);
}

export function canManageCards(user: User | null | undefined): boolean {
  return hasAny(user, ADMIN_ROLES);
}

/** Roles an account of this kind can hold: staff roles for staff, partner roles for partners. */
export function rolesForKind(roles: readonly RoleDefinition[], kind: UserKind): RoleDefinition[] {
  return roles.filter((role) => role.scope === kind);
}

export function toggleRole(selected: readonly string[], role: string, on: boolean): string[] {
  if (!on) return selected.filter((code) => code !== role);
  return selected.includes(role) ? [...selected] : [...selected, role];
}

export function isStaff(user: User | null | undefined): boolean {
  return user?.kind === "INTERNAL";
}

/** A staff account that signed in through the portal but has no role yet. */
export function awaitsRoleAssignment(user: User | null | undefined): boolean {
  return !!user && user.kind === "INTERNAL" && user.roles.length === 0;
}
