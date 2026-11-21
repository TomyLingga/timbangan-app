// Shapes the API sends. Phase 3 and the permission shapes follow the views of
// apps/api (registrations/view.ts, trips/view.ts, trips/routes.ts, auth/guard.ts).

export type UserKind = "INTERNAL" | "PARTNER";

export interface PartnerRef {
  id: string | number;
  name: string;
}

/** Modules the routes of this phase check (apps/api src/auth/permissions.ts). */
export type ModuleCode =
  | "contracts"
  | "drivers"
  | "vehicles"
  | "destinations"
  | "delivery_orders"
  | "registrations"
  | "gate"
  | "rfid_cards"
  | "users"
  // phase 4: weighing, decisions, field steps, reports
  | "weighbridge"
  | "approvals"
  | "qc"
  | "qc_approvals"
  | "security_check"
  | "unloading"
  | "loading"
  | "sealing"
  | "reports"
  // phase 5 and 6: plant masters, control room
  | "plant_masters"
  | "dashboard";

/** EDIT covers CREATE, CREATE covers VIEW. */
export type PermissionLevel = "VIEW" | "CREATE" | "EDIT";

/** Level per module the account may open; a module that is absent cannot be opened. */
export type Permissions = Partial<Record<string, PermissionLevel>>;

/** The company of a partner account; the flags say which kinds of partner it is. */
export interface AccountPartner extends PartnerRef {
  isSupplier: boolean;
  isTransporter: boolean;
  isCustomer: boolean;
}

export interface User {
  id: string | number;
  kind: UserKind;
  username: string;
  fullName: string;
  permissions: Permissions;
  partner: AccountPartner | null;
}

/** One row of GET /api/admin/modules. */
export interface ModuleDefinition {
  code: string;
  name: string;
  levels: PermissionLevel[];
  partnerAllowed: boolean;
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
  /** The tank step of the same run (apps/api src/odoo/sync.ts); absent from older API versions. */
  tanks?: TankSyncResult;
  durationMs: number;
}

export type TankSyncResult =
  | { status: "OK"; written: number; deactivated: number; skipped: number }
  | { status: "SKIPPED"; reason: string };

/** GET /api/tanks (apps/api src/plant-masters/routes.ts). */
export interface StorageTank {
  id: string | number;
  code: string;
  name: string | null;
  product: { id: string | number; name: string | null } | null;
  /** The product name Odoo keeps on the tank, shown when no synced product matched it. */
  productLabel: string | null;
  capacityKg: number | null;
  isActive: boolean;
  /** ODOO: maintained in Odoo, only isActive changes here. */
  source: "ODOO" | "LOCAL";
}

/** GET /api/seals. */
export interface Seal {
  id: string | number;
  sealNo: string;
  kind: string;
  status: string;
  batchRef: string | null;
  createdAt: string;
  trip: { id: string | number; tripNo: string | null; plateNo: string | null } | null;
}

/** POST /api/seals/batch. */
export interface SealBatchResult {
  created: number;
  skipped: number;
  first: string;
  last: string;
}

/** A file linked to a DO or a truck (apps/api src/attachments/routes.ts). */
export interface AttachedFile {
  id: string | number;
  label: string | null;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  addedAt: string | null;
  addedBy: { id: string | number; fullName: string } | null;
}

/** POST /api/files. */
export interface UploadedFile {
  id: string | number;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
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

export interface AdminUser {
  id: string | number;
  kind: UserKind;
  username: string;
  fullName: string;
  employeeNo: string | null;
  partner: PartnerRef | null;
  permissions: Permissions;
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
// As apps/api sends them (registrations/view.ts, trips/view.ts, trips/routes.ts,
// delivery-orders/routes.ts, gate/routes.ts, lookup/routes.ts). Status values
// stay strings because later phases add trip statuses.

export type Numeric = number | null;

export interface RfidCard {
  id: string | number;
  uid: string;
  label: string | null;
  status: string;
  note: string | null;
  trip: { id: string | number; tripNo: string | null; plateNo: string | null } | null;
}

/** Typed on the DO since API migration 0008; `id` is the old master row of earlier DOs, else null. */
export interface DeliveryOrderDestination {
  id: string | number | null;
  name: string;
  address: string | null;
  district: string | null;
  regency: string | null;
  province: string | null;
}

export interface DeliveryOrder {
  id: string | number;
  doNo: string;
  doDate: string;
  status: string;
  contract: { id: string | number; contractNo: string | null } | null;
  customerPoNo: string | null;
  partner: PartnerRef;
  product: { id: string | number; name: string; category: string | null };
  qty: number;
  uom: string;
  tolerancePct: number;
  destination: DeliveryOrderDestination;
  deliveryFrom: string;
  deliveryUntil: string | null;
  transportTerms: string | null;
  transporter: PartnerRef | null;
  truckCount: number | null;
  truckCountBy: string | null;
  qtyPlanned: number;
  qtyRemaining: number;
  tripCount: number;
  remark: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
}

/** GET /api/delivery-orders/:id: the DO and every truck registered on it. */
export interface DeliveryOrderDetail {
  deliveryOrder: DeliveryOrder;
  trips: Trip[];
  /** The DO letter and other files logistics attached. */
  files?: AttachedFile[];
}

/** One finding of a registration check. `tripSeq` and `allocationSeq` point at what it is about. */
export interface Finding {
  code: string;
  message: string;
  tripSeq?: number;
  allocationSeq?: number;
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
  quality: Record<string, number>;
}

export interface Spj {
  id: string | number;
  spjNo: string;
  barcodeToken: string;
  issuedAt: string;
  validUntil: string | null;
  printCount: number;
}

/** A trip as every route answers it: the desk lists, the scan, a registration and a DO. */
export interface Trip {
  id: string | number;
  registrationId: string | number;
  seq: number;
  tripNo: string | null;
  status: string;
  direction: Direction;
  flowCode: string;
  partner: PartnerRef;
  transporter: PartnerRef | null;
  currentStep: string | null;
  vehicle: { id: string | number; plateNo: string; plateDisplay: string; vehicleTypeCode: string } | null;
  driver: { id: string | number; fullName: string; licenceNo: string; registryStatus: string } | null;
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
  cancelReason: string | null;
  /** Weighbridge slips of the supplier's scale (incoming only). */
  slips?: AttachedFile[];
}

export interface RegistrationAllocation {
  seq: number;
  contract: { id: string | number; contractNo: string } | null;
  deliveryOrder: { id: string | number; doNo: string | null } | null;
  contractNo: string;
  doNo: string | null;
  qtyPlanned: Numeric;
  tolerancePct: number;
  product: { id: string | number; name: string; category: string | null };
  partner: PartnerRef;
}

export interface Registration {
  id: string | number;
  regNo: string;
  direction: Direction;
  flowCode: string;
  status: string;
  partner: PartnerRef;
  transporter: PartnerRef | null;
  plannedDate: string | null;
  truckCount: number;
  qtyTotal: Numeric;
  uom: string;
  closeCargo: boolean | null;
  flexiBag: boolean | null;
  remark: string | null;
  createdVia: string;
  createdBy: { id: string | number; fullName: string };
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  findings: Finding[];
  allocations: RegistrationAllocation[];
  trips: Trip[];
}

/** A list row: the registration without its trips. */
export type RegistrationSummary = Omit<Registration, "trips">;

export interface SpjPrint {
  spjNo: string;
  barcodeToken: string;
  issuedAt: string;
  validUntil: string | null;
  printCount: number;
  site: { code: string; name: string };
  direction: Direction;
  driver: { fullName: string | null; licenceNo: string | null };
  vehicle: { plateDisplay: string | null; vehicleType: string | null };
  containerNo: string | null;
  transporter: PartnerRef | null;
  lines: SpjLine[];
}

export interface SpjLine {
  contractNo: string;
  doNo: string | null;
  product: { id: string | number; name: string };
  qtyPlanned: Numeric;
  uom: string | null;
  partner: PartnerRef;
  destination: DeliveryOrderDestination | null;
}

export interface GateCheck {
  code: string;
  level: "BLOCK" | "WARN";
  message: string;
}

export interface GateScan {
  trip: Trip;
  checks: GateCheck[];
}

export interface QualityParameter {
  code: string;
  name: string;
  unit: string;
  decimals: number;
  minValid: number;
  maxValid: number;
}

export interface Product {
  id: string | number;
  name: string;
  category: string | null;
}

/** GET /api/lookup/driver: one driver by its whole licence number. */
export interface LookupDriver {
  id: string | number;
  fullName: string;
  licenceNo: string;
  licenceClass: string | null;
  licenceValidUntil: string | null;
  licenceExpired: boolean;
  registryStatus: string;
  blocked: boolean;
  isActive: boolean;
}

/** GET /api/lookup/vehicle: one vehicle by its whole plate. */
export interface LookupVehicle {
  id: string | number;
  plateNo: string;
  plateDisplay: string;
  vehicleTypeCode: string | null;
  needsContainerNo: boolean;
  capacityKg: number | null;
  tareKg: number | null;
  /** Papers past today: "STNK", "TAX", "KIR". */
  expired: string[];
  verified: boolean;
  owner: PartnerRef | null;
  isActive: boolean;
}

// --- phase 4: stations, weighing, decisions, field steps, reports --------------------

export type StationKind = "REGISTRATION" | "GATE" | "WEIGHBRIDGE" | "QC" | "STAGING" | "UNLOADING_BAY" | "LOADING_BAY" | "DOCK" | "SEALING";

/** The config of a weighbridge station (apps/api stations/routes.ts, weighbridgeConfig). */
export interface WeighbridgeConfig {
  directions: Direction[];
  cameraWeigh1: number | null;
  cameraWeigh2: number | null;
  plateAttempts: number;
}

/** GET /api/stations, one station. */
export interface Station {
  id: string | number;
  code: string;
  name: string;
  kind: StationKind;
  zoneId: number | null;
  config: Record<string, unknown>;
  isActive: boolean;
  hasKey: boolean;
  keyCreatedAt: string | null;
  hasPin: boolean;
}

export type ExceptionType = "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT" | "QC_HOLD";
export type ExceptionStatus = "PENDING" | "APPROVED" | "REJECTED" | "RETRY" | "CANCELLED" | "EXPIRED";

/** A request for a decision (apps/api exceptions/service.ts, loadExceptionViews). */
export interface ExceptionView {
  id: string | number;
  type: ExceptionType;
  status: ExceptionStatus;
  decision: string | null;
  trip: { id: string | number; tripNo: string | null; plateNo: string | null; plateDisplay: string | null };
  station: { id: string | number; code: string; name: string } | null;
  stage: number | null;
  expectedValue: number | null;
  actualValue: number | null;
  diffValue: number | null;
  diffPct: number | null;
  tolerancePct: number | null;
  liveWeightKg: number | null;
  liveWeightAt: string | null;
  plateRead: string | null;
  plateNo: string | null;
  approverModule: string;
  raisedAt: string;
  decidedAt: string | null;
  decidedBy: { id: string | number; fullName: string | null } | null;
  reason: string | null;
  reportNo: string | null;
  weighingId: string | number | null;
  context: Record<string, unknown> | null;
}

export type StepStatus = "PENDING" | "READY" | "IN_PROGRESS" | "DONE" | "SKIPPED" | "FAILED";

/** A step of a trip (apps/api trips/work-routes.ts, stepView). */
export interface TripStep {
  stepCode: string;
  name: string;
  seq: number;
  attempt: number;
  status: StepStatus;
  result: string | null;
  performerModule: string | null;
  isOptional: boolean;
  onReject: string;
  readyAt: string | null;
  finishedAt: string | null;
  performedBy: string | number | null;
  stationId: string | number | null;
  note: string | null;
}

/** A weighing (apps/api weighing/view.ts, weighingView). */
export interface Weighing {
  id: string | number;
  stage: number;
  kind: "GROSS" | "TARE";
  weightKg: number;
  weighedAt: string;
  mode: "AUTO" | "EXCEPTION";
  plateRead: string | null;
  plateCheck: "MATCH" | "CONFIRMED" | "BYPASSED";
  stationId: string | number | null;
  status: string;
}

/** One share of a truck's net (apps/api weighing/view.ts, AllocationView). */
export interface AllocationShare {
  seq: number;
  contractNo: string;
  doNo: string | null;
  uom: string;
  qtyPlanned: number | null;
  originNetKg: number | null;
  netKg: number | null;
  qtyActual: number | null;
  splitMethod: string | null;
}

/** A trip as the weighing pages show it (apps/api weighing/view.ts, WeighTrip). */
export interface WeighTrip {
  id: string | number;
  tripNo: string | null;
  status: string;
  outcome: string | null;
  direction: Direction;
  flowCode: string;
  currentStep: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  driverName: string | null;
  partner: { id: string | number; name: string };
  transporter: { id: string | number; name: string } | null;
  qtyPlanned: number | null;
  docGrossKg: number | null;
  docTareKg: number | null;
  docNetKg: number | null;
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
  allocations: AllocationShare[];
}

/** GET /api/trips/:id/steps */
export interface TripWork {
  trip: WeighTrip;
  steps: TripStep[];
  weighings: Weighing[];
}

/** GET /api/reports/contracts, one row. */
export interface ContractReportRow {
  contractId: string | number;
  contractNo: string;
  direction: Direction;
  partner: string;
  product: string;
  uom: string | null;
  state: string;
  qtyContract: number | null;
  qtyOpening: number;
  realised: number;
  realisedTotal: number;
  inProgress: number;
  remaining: number | null;
  tripCount: number;
}

/** GET /api/reports/trips, one row per truck allocation. */
export interface TripReportRow {
  tripId: string | number;
  tripNo: string | null;
  status: string;
  outcome: string | null;
  direction: Direction;
  plateNo: string | null;
  seq: number;
  contractNo: string;
  doNo: string | null;
  uom: string;
  grossKg: number | null;
  tareKg: number | null;
  truckNetKg: number | null;
  shareNetKg: number | null;
  qtyActual: number | null;
  splitMethod: string | null;
  weigh1At: string | null;
  weigh2At: string | null;
}