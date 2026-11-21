// Shapes taken from the API contract. Fields the contract leaves open
// (state values, numeric fields that may arrive as strings) are typed loosely.

export type UserKind = "INTERNAL" | "PARTNER";

export interface PartnerRef {
  id: string | number;
  name: string;
}

export interface User {
  id: string | number;
  kind: UserKind;
  username: string;
  fullName: string;
  roles: string[];
  partner: PartnerRef | null;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

export type Direction = "IN" | "OUT";

export interface Contract {
  id: string | number;
  contractNo: string;
  direction: Direction;
  partner: PartnerRef;
  product: { id: string | number; name: string; category: string | null };
  qtyContract: number | string | null;
  uom: string | null;
  tolerancePct: number | string | null;
  certificate: string | null;
  validFrom: string | null;
  validUntil: string | null;
  customerPoNo: string | null;
  state: string;
  syncedAt: string | null;
}

export interface ContractList {
  items: Contract[];
  total: number;
}

export interface SyncResult {
  contracts: number;
  partners: number;
  products: number;
  skipped: number;
  durationMs: number;
}

export interface SyncRun {
  id: string | number;
  entity: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  rowsUpserted: number | null;
  error: string | null;
}

export interface SyncRunList {
  items: SyncRun[];
}

/** Every list answers this shape. There is no offset: pages are search-first. */
export interface Page<T> {
  items: T[];
  total: number;
}

export interface RoleDefinition {
  code: string;
  name: string;
  scope: UserKind;
}

export interface AdminUser {
  id: string | number;
  kind: UserKind;
  username: string;
  fullName: string;
  employeeNo: string | null;
  partner: PartnerRef | null;
  roles: string[];
  isActive: boolean;
  lastLoginAt: string | null;
}

export type RegistryStatus = "NORMAL" | "WARNING" | "BLACKLIST" | "UNKNOWN";

export interface Driver {
  id: string | number;
  fullName: string;
  licenceNo: string;
  licenceClass: string | null;
  licenceValidUntil: string | null;
  licenceExpired: boolean;
  registryStatus: string | null;
  registrySyncedAt: string | null;
  /** Whether a driver entered here still has to be sent to the registry. */
  registryPush: string | null;
  /** Why the last attempt to send it failed, as the server wrote it. */
  registryPushError: string | null;
  isActive: boolean;
}

export type RegistryPush = "PENDING" | "FAILED" | "SENT" | "NONE";

export interface VcfSyncResult {
  drivers: number;
  transporters: number;
  skipped: number;
  durationMs: number;
  /** Drivers sent to the registry during this run, and those it refused or that failed. */
  pushed: number;
  pushFailed: number;
  /** Set when sending stopped before every waiting driver was tried. */
  pushStopped?: boolean | string | null;
}

export interface VehicleType {
  code: string;
  name: string;
  isTank: boolean;
  needsContainerNo: boolean;
}

export type Ownership = "SENDIRI" | "MITRA";

export interface Vehicle {
  id: string | number;
  plateNo: string;
  plateDisplay: string;
  vehicleTypeCode: string | null;
  owner: PartnerRef | null;
  ownership: Ownership | null;
  capacityKg: number | string | null;
  productionYear: number | null;
  tareKg: number | string | null;
  stnkValidUntil: string | null;
  taxValidUntil: string | null;
  kirValidUntil: string | null;
  expired: string[];
  isActive: boolean;
  verified: boolean;
}

export type PartnerRole = "supplier" | "customer" | "transporter";

export interface Partner {
  id: string | number;
  name: string;
  code: string | null;
  isSupplier: boolean;
  isCustomer: boolean;
  isTransporter: boolean;
}

export interface Destination {
  id: string | number;
  partner: PartnerRef | null;
  name: string;
  address: string;
  district: string | null;
  regency: string | null;
  province: string | null;
  isActive: boolean;
}
