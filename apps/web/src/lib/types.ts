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
  | "delivery_orders"
  | "registrations"
  | "gate"
  // typing a registration at the post when the document could not be read (API migration 0015); VIEW is its only level
  | "gate_emergency"
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
  | "dashboard"
  // phase 8: GPS positions of trucks outside the plant
  | "gps"
  // migration 0017: the INL team asks a supplier to deliver on a purchase contract
  | "shipment_requests";

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
  /**
   * A partner account: the shipment request sent to its company (API migration 0018), with its quantity; null
   * without one. Staff: always null, they get `requests`. Absent from an older API.
   */
  shipmentRequest?: { id: string | number; status: string; sentAt: string | null; qtyPlanned?: number | null } | null;
  /** Staff: the requests of the contract to every mill (open, sent) and what those not cancelled plan together. */
  requests?: { open: number; sent: number; qtyRequested: number } | null;
}

/** A person named on a record: who made, sent, closed or cancelled it. */
export interface PersonRef {
  id: string | number;
  fullName: string | null;
}

/** GET /api/shipment-requests and /:id (apps/api src/shipment-requests/view.ts). DRAFT, SENT, CLOSED, CANCELLED. */
export interface ShipmentRequest {
  id: string | number;
  status: string;
  contract: {
    id: string | number;
    contractNo: string;
    state: string;
    qtyContract: number | null;
    uom: string | null;
    tolerancePct: number | null;
    validFrom: string | null;
    validUntil: string | null;
    /** Staff: what the requests of the contract that are not cancelled plan together; null for a supplier account. */
    qtyRequested?: number | null;
  };
  product: { id: string | number; name: string; category: string | null };
  /** The partner of the contract (a trader, or the mill itself). */
  partner: PartnerRef;
  /** The mill (PKS) the request is sent to (API migration 0018). */
  supplier: PartnerRef;
  qtyPlanned: number | null;
  uom: string | null;
  deliveryFrom: string | null;
  deliveryUntil: string | null;
  remark: string | null;
  fileCount: number;
  createdBy: PersonRef;
  createdAt: string;
  sentBy: PersonRef | null;
  sentAt: string | null;
  closedBy: PersonRef | null;
  closedAt: string | null;
  cancelledBy: PersonRef | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
}

/** GET /api/shipment-requests/:id: the request and the contract PDF it carries. */
export interface ShipmentRequestDetail {
  shipmentRequest: ShipmentRequest;
  files: AttachedFile[];
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
  /** False for a tank with neither product nor label: the field forms never offer or accept it. */
  usableInForms: boolean;
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
  /** The vehicle has an active GPS tracker (apps/api vehicles, phase 8); absent in older answers. */
  hasGps?: boolean;
}

export type PartnerRole = "supplier" | "customer" | "transporter";

export interface Partner {
  id: string | number;
  name: string;
  code: string | null;
  address?: string | null;
  isSupplier: boolean;
  isCustomer: boolean;
  isTransporter: boolean;
  /** Null for a partner kept only in this application (a mill that sells through a trader). */
  erpSystem?: string | null;
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
  /** The optional map pin (API migration 0013); absent from an older API. */
  location?: { lat: number; lon: number } | null;
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
  /** The transporter; for a DO sent to its customer, the customer itself (API migration 0017). */
  transporter: PartnerRef | null;
  /** Whom the DO was sent to; null before sending. Absent from an older API. */
  sentTo?: "TRANSPORTER" | "CUSTOMER" | null;
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
  /**
   * Outgoing: as the post marked the truck at check-in; before that, what an older registration carries. Null:
   * not marked yet, or an incoming truck. Absent from an API before migration 0015.
   */
  closeCargo?: boolean | null;
  flexiBag?: boolean | null;
  /** Outgoing, free and optional (API migration 0016): an extra SPBE, the passport or travel letter. */
  extraSpbe?: string | null;
  passportNo?: string | null;
  allocations: TripAllocation[];
  /** In a registration's detail: whether the truck may still change, and why not (API, 26 November 2026). */
  edit?: { allowed: boolean; reason: string | null };
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
  /** Asal PKS: the mill the truck comes from (API migration 0018); null when not known. */
  originPartner?: PartnerRef | null;
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
  /** In the detail: whether the registration may still change, and whether its contracts or DOs are fixed. */
  edit?: { allowed: boolean; allocationsLocked: boolean; reason: string | null };
}

/** What happened to the SPJ of a truck when a sent registration changed (PUT /api/registrations/:id). */
export interface SpjChange {
  tripId: string | number;
  seq: number;
  plateNo: string | null;
  change: "REISSUED" | "ISSUED" | "WITHDRAWN" | "CANCELLED";
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
  /** The driver's page that shares the phone's location for this trip; null when the trip has no active link. */
  shareUrl?: string | null;
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
  /** What may be decided while PENDING (allowedDecisions in apps/api/src/exceptions/service.ts). */
  options?: string[];
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

/** One signature column of a Berita Acara: the operator who checked the truck in, and the approver. */
export interface ReportSigner {
  role: string;
  title: string;
  position: string;
  user: { id: string | number; fullName: string | null } | null;
}

/** GET /api/exceptions/:id/report: the data of the Berita Acara of an approved request (apps/api src/exceptions/routes.ts). */
export interface ExceptionReport {
  reportNo: string;
  /** "Berita Acara Selisih Bruto", "Berita Acara Plat Tidak Sesuai", ... */
  title: string;
  type: string;
  exceptionId: string | number;
  site: { code: string; name: string };
  trip: {
    id: string | number;
    tripNo: string | null;
    plateNo: string | null;
    plateDisplay: string | null;
    driverName: string | null;
    direction: Direction;
    partner: string;
    transporter: string | null;
  };
  lines: Array<{ seq: number; contractNo: string | null; doNo: string | null }>;
  station: { code: string | null; name: string | null };
  expectedKg: number | null;
  weighedKg: number | null;
  diffKg: number | null;
  diffPct: number | null;
  tolerancePct: number | null;
  weighing: { id: string | number; weightKg: number | null; weighedAt: string | null } | null;
  reason: string | null;
  raisedAt: string;
  decidedAt: string | null;
  decidedBy: { id: string | number; fullName: string | null } | null;
  masterTareUpdated: boolean;
  /** A plate Berita Acara: what the camera read (null: not read) and the registered plate; null for weights. */
  plate: { read: string | null; registered: string | null } | null;
  signers: ReportSigner[];
}

export type StepStatus ="PENDING" | "READY" | "IN_PROGRESS" | "DONE" | "SKIPPED" | "FAILED";

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

/** One page of a report: the rows, how many match in all, and totals over all of them. */
export interface ReportPage<Row, Totals> {
  items: Row[];
  total: number;
  limit: number;
  offset: number;
  totals: Totals;
}

/** GET /api/reports/contracts, totals over every matching line. */
export interface ContractReportTotals {
  /** A plain sum over every unit; `realisedByUom` keeps the units apart. */
  realised: number;
  realisedByUom: { uom: string | null; realised: number }[];
  /** Trucks completed in the period; a truck on two contracts counts once. */
  tripCount: number;
}

/** GET /api/reports/trips, totals over every matching line. */
export interface TripReportTotals {
  tripCount: number;
  shareNetKg: number;
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