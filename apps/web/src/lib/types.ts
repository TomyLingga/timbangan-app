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

// --- phase 3: RFID cards, delivery orders, registrations, trips, SPJ --------
// Shapes from section 3 of docs/fase-3-rancangan.md. Status values are typed as
// string because the contract may grow them (Phase 4 adds trip statuses).

export type Numeric = number | string | null;

export interface RfidCard {
  id: string | number;
  uid: string;
  label: string | null;
  status: string;
  note: string | null;
  trip: { id: string | number; tripNo: string | null; plateNo: string | null } | null;
}

export interface DeliveryOrder {
  id: string | number;
  doNo: string;
  doDate: string | null;
  status: string;
  contract: { id: string | number; contractNo: string } | null;
  customerPoNo: string | null;
  /** The contract names it "partner" without a shape; read as a reference. */
  partner: PartnerRef | null;
  product: { id: string | number; name: string; category: string | null } | null;
  qty: Numeric;
  uom: string | null;
  tolerancePct: Numeric;
  destination: {
    id: string | number;
    name: string;
    address: string | null;
    district: string | null;
    regency: string | null;
    province: string | null;
  } | null;
  deliveryFrom: string | null;
  deliveryUntil: string | null;
  transportTerms: string | null;
  transporter: PartnerRef | null;
  truckCount: number | null;
  truckCountBy: string | null;
  qtyPlanned: Numeric;
  qtyRemaining: Numeric;
  tripCount: number | null;
  remark: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
}

/** One finding of a registration check. `tripSeq` and `allocationSeq` point at what it is about. */
export interface Finding {
  code: string;
  message: string | null;
  tripSeq?: number | null;
  allocationSeq?: number | null;
}

export interface TripAllocation {
  seq: number;
  qtyPlanned: Numeric;
  handoverNo: string | null;
  spbNo: string | null;
  spbDate: string | null;
  originTicketNo: string | null;
  originGrossKg: Numeric;
  originTareKg: Numeric;
  originNetKg: Numeric;
  quality: Record<string, number | string> | null;
}

export interface Spj {
  id: string | number;
  spjNo: string;
  barcodeToken: string;
  issuedAt: string | null;
  validUntil: string | null;
  printCount: number | null;
}

export interface Trip {
  id: string | number;
  seq: number;
  tripNo: string | null;
  status: string;
  vehicle: { id: string | number; plateNo: string; plateDisplay: string; vehicleTypeCode: string | null } | null;
  driver: { id: string | number; fullName: string; licenceNo: string; registryStatus: string | null } | null;
  containerNo: string | null;
  plannedArrival: string | null;
  qtyPlanned: Numeric;
  docGrossKg: Numeric;
  docTareKg: Numeric;
  docNetKg: Numeric;
  allocations: TripAllocation[];
  spj: Spj | null;
  card: { uid: string; label: string | null } | null;
  checkedInAt: string | null;
}

/** `Trip` in short, with what the lists at the post need. Every extra field is optional on purpose. */
export interface TripSummary extends Partial<Omit<Trip, "id" | "status">> {
  id: string | number;
  status: string;
  direction?: Direction | null;
  flowCode?: string | null;
  partner?: PartnerRef | null;
  transporter?: PartnerRef | null;
  currentStep?: string | null;
}

export interface RegistrationAllocation {
  seq: number;
  contract: { id: string | number; contractNo: string } | null;
  deliveryOrder: { id: string | number; doNo: string } | null;
  contractNo: string | null;
  doNo: string | null;
  qtyPlanned: Numeric;
  tolerancePct: Numeric;
  product: { id: string | number; name: string; category?: string | null } | null;
  partner: PartnerRef | null;
}

export interface Registration {
  id: string | number;
  regNo: string;
  direction: Direction;
  flowCode: string | null;
  status: string;
  partner: PartnerRef | null;
  transporter: PartnerRef | null;
  plannedDate: string | null;
  truckCount: number | null;
  qtyTotal: Numeric;
  uom: string | null;
  closeCargo: boolean | null;
  flexiBag: boolean | null;
  remark: string | null;
  createdVia: string | null;
  createdBy: { id: string | number; fullName: string } | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  findings: Finding[];
  allocations: RegistrationAllocation[];
  trips: Trip[];
}

/**
 * The contract names `RegistrationSummary` without its fields. The list reads
 * the fields of `Registration` it needs and treats every one as optional.
 */
export type RegistrationSummary = Partial<Registration> & Pick<Registration, "id" | "regNo" | "status">;

export interface SpjPrint {
  spjNo: string;
  barcodeToken: string;
  issuedAt: string | null;
  validUntil: string | null;
  /** Shape left open by the contract: a code, a name, or both. */
  site: string | { code?: string | null; name?: string | null } | null;
  direction: Direction;
  driver: { fullName: string; licenceNo: string } | null;
  vehicle: { plateDisplay: string; vehicleType: string | null } | null;
  transporter: PartnerRef | string | null;
  lines: SpjLine[];
}

export interface SpjLine {
  contractNo: string | null;
  doNo: string | null;
  product: { name: string } | string | null;
  qtyPlanned: Numeric;
  uom: string | null;
  partner: PartnerRef | string | null;
  destination: { name: string; address?: string | null } | string | null;
}

export interface GateCheck {
  code: string;
  level: string;
  message: string | null;
}

export interface GateScan {
  trip: TripSummary;
  checks: GateCheck[];
}

/** Not in the contract: the incoming form needs the parameter list and its plausible range. */
export interface QualityParameter {
  code: string;
  name: string;
  unit: string | null;
  decimals: number | null;
  minValid: Numeric;
  maxValid: Numeric;
}

/** Not in the contract: a delivery order without a contract needs a product to choose from. */
export interface Product {
  id: string | number;
  name: string;
  category: string | null;
}
