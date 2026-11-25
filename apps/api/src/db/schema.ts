// Drizzle definitions of the tables this slice reads and writes. The SQL files in `migrations/` are the
// source of truth; test/schema-drift.test.ts fails when a definition here no longer matches the database.
// Constraints (checks, unique indexes, foreign keys) live in the migrations only.
import { bigint, boolean, date, doublePrecision, inet, integer, jsonb, numeric, pgTable, real, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const partners = pgTable("partners", {
  id: id(),
  erpSystem: text("erp_system"),
  erpRef: text("erp_ref"),
  code: text("code"),
  name: text("name").notNull(),
  address: text("address"),
  isSupplier: boolean("is_supplier").notNull().default(false),
  isCustomer: boolean("is_customer").notNull().default(false),
  isTransporter: boolean("is_transporter").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  syncedAt: timestamptz("synced_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: id(),
  kind: text("kind", { enum: ["INTERNAL", "PARTNER"] }).notNull(),
  partnerId: bigint("partner_id", { mode: "number" }),
  siteId: smallint("site_id"),
  username: text("username").notNull(),
  fullName: text("full_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  passwordHash: text("password_hash"),
  ssoSubject: text("sso_subject"),
  employeeNo: text("employee_no"),
  ssoProfile: jsonb("sso_profile"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamptz("last_login_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const PERMISSION_LEVELS = ["VIEW", "CREATE", "EDIT"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const modules = pgTable("modules", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  sortOrder: smallint("sort_order").notNull(),
  levels: text("levels", { enum: PERMISSION_LEVELS }).array().notNull(),
  partnerAllowed: boolean("partner_allowed").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
});

export const userPermissions = pgTable("user_permissions", {
  userId: bigint("user_id", { mode: "number" }).notNull(),
  moduleCode: text("module_code").notNull(),
  level: text("level", { enum: PERMISSION_LEVELS }).notNull(),
  grantedBy: bigint("granted_by", { mode: "number" }),
  grantedAt: timestamptz("granted_at").notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: id(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  tokenHash: text("token_hash").notNull(),
  client: text("client", { enum: ["WEB", "ANDROID", "IOS"] }).notNull(),
  deviceLabel: text("device_label"),
  ip: inet("ip"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  lastUsedAt: timestamptz("last_used_at"),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
});

export const products = pgTable("products", {
  id: id(),
  erpSystem: text("erp_system"),
  erpRef: text("erp_ref"),
  code: text("code"),
  name: text("name").notNull(),
  uom: text("uom").notNull().default("kg"),
  category: text("category", { enum: ["CPO", "BULK_LIQUID", "PACKED", "MATERIAL", "OTHER"] }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  syncedAt: timestamptz("synced_at"),
});

export const erpContracts = pgTable("erp_contracts", {
  id: id(),
  erpSystem: text("erp_system").notNull(),
  erpRef: text("erp_ref").notNull(),
  siteId: smallint("site_id"),
  direction: text("direction", { enum: ["IN", "OUT"] }).notNull(),
  contractNo: text("contract_no").notNull(),
  partnerId: bigint("partner_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  qtyContract: numeric("qty_contract", { precision: 16, scale: 3, mode: "number" }),
  qtyDoneErp: numeric("qty_done_erp", { precision: 16, scale: 3, mode: "number" }),
  qtyOpening: numeric("qty_opening", { precision: 16, scale: 3, mode: "number" }).notNull().default(0),
  customerPoNo: text("customer_po_no"),
  contractDate: date("contract_date"),
  uom: text("uom").notNull().default("kg"),
  tolerancePct: numeric("tolerance_pct", { precision: 7, scale: 4, mode: "number" }).notNull().default(0),
  certificate: text("certificate"),
  validFrom: date("valid_from"),
  validUntil: date("valid_until"),
  state: text("state", { enum: ["OPEN", "CLOSED", "CANCELLED"] }).notNull(),
  raw: jsonb("raw"),
  syncedAt: timestamptz("synced_at").notNull().defaultNow(),
});

export const erpSyncRuns = pgTable("erp_sync_runs", {
  id: id(),
  erpSystem: text("erp_system").notNull(),
  entity: text("entity").notNull(),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
  finishedAt: timestamptz("finished_at"),
  status: text("status", { enum: ["RUNNING", "OK", "FAILED"] }).notNull().default("RUNNING"),
  cursorValue: text("cursor_value"),
  rowsUpserted: integer("rows_upserted").notNull().default(0),
  error: text("error"),
});

export const auditLog = pgTable("audit_log", {
  id: id(),
  at: timestamptz("at").notNull().defaultNow(),
  userId: bigint("user_id", { mode: "number" }),
  stationId: integer("station_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: bigint("entity_id", { mode: "number" }),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  ip: inet("ip"),
});

export const vehicleTypes = pgTable("vehicle_types", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  isTank: boolean("is_tank").notNull().default(false),
  needsContainerNo: boolean("needs_container_no").notNull().default(false),
});

export const vehicles = pgTable("vehicles", {
  id: id(),
  plateNo: text("plate_no").notNull(),
  plateDisplay: text("plate_display").notNull(),
  vehicleTypeCode: text("vehicle_type_code").notNull(),
  ownerPartnerId: bigint("owner_partner_id", { mode: "number" }),
  ownership: text("ownership", { enum: ["SENDIRI", "MITRA"] }),
  capacityKg: integer("capacity_kg"),
  productionYear: smallint("production_year"),
  tareKg: integer("tare_kg"),
  stnkValidUntil: date("stnk_valid_until"),
  taxValidUntil: date("tax_valid_until"),
  kirValidUntil: date("kir_valid_until"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: bigint("created_by", { mode: "number" }),
  verifiedBy: bigint("verified_by", { mode: "number" }),
  verifiedAt: timestamptz("verified_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const vehicleTareHistory = pgTable("vehicle_tare_history", {
  id: id(),
  vehicleId: bigint("vehicle_id", { mode: "number" }).notNull(),
  tareKg: integer("tare_kg").notNull(),
  source: text("source", { enum: ["MANUAL", "WEIGHING", "IMPORT"] }).notNull(),
  weighingId: bigint("weighing_id", { mode: "number" }),
  reason: text("reason"),
  changedBy: bigint("changed_by", { mode: "number" }),
  changedAt: timestamptz("changed_at").notNull().defaultNow(),
});

export const drivers = pgTable("drivers", {
  id: id(),
  fullName: text("full_name").notNull(),
  licenceNo: text("licence_no").notNull(),
  licenceClass: text("licence_class"),
  licenceValidUntil: date("licence_valid_until"),
  phone: text("phone"),
  homePartnerId: bigint("home_partner_id", { mode: "number" }),
  registryRef: text("registry_ref"),
  registryStatus: text("registry_status", { enum: ["UNKNOWN", "NORMAL", "WARNING", "BLACKLIST"] }).notNull().default("UNKNOWN"),
  registrySyncedAt: timestamptz("registry_synced_at"),
  registryPush: text("registry_push", { enum: ["NONE", "PENDING", "SENT", "FAILED"] }).notNull().default("NONE"),
  registryPushError: text("registry_push_error"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: bigint("created_by", { mode: "number" }),
  verifiedBy: bigint("verified_by", { mode: "number" }),
  verifiedAt: timestamptz("verified_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const destinations = pgTable("destinations", {
  id: id(),
  partnerId: bigint("partner_id", { mode: "number" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  district: text("district"),
  regency: text("regency"),
  province: text("province"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: bigint("created_by", { mode: "number" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// --- Phase 3: sites, settings, numbering, delivery orders, registrations, trips, SPJ, cards ---

export const sites = pgTable("sites", {
  id: smallint("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  isActive: boolean("is_active").notNull().default(true),
});

export const settings = pgTable("settings", {
  siteId: smallint("site_id"),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedBy: bigint("updated_by", { mode: "number" }),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const documentCounters = pgTable("document_counters", {
  counterKey: text("counter_key").primaryKey(),
  lastNo: integer("last_no").notNull().default(0),
});

export const flowSteps = pgTable("flow_steps", {
  siteId: smallint("site_id").notNull(),
  flowCode: text("flow_code").notNull(),
  stepCode: text("step_code").notNull(),
  seq: smallint("seq").notNull(),
  name: text("name").notNull(),
  isOptional: boolean("is_optional").notNull().default(false),
  onReject: text("on_reject").notNull().default("SKIP"),
  performerModule: text("performer_module"),
  waitZoneId: integer("wait_zone_id"),
  workZoneId: integer("work_zone_id"),
});

export const driverBlocks = pgTable("driver_blocks", {
  id: id(),
  driverId: bigint("driver_id", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  source: text("source", { enum: ["LOCAL", "CENTRAL"] }).notNull().default("LOCAL"),
  blockedBy: bigint("blocked_by", { mode: "number" }),
  blockedAt: timestamptz("blocked_at").notNull().defaultNow(),
  blockedUntil: timestamptz("blocked_until"),
  liftedBy: bigint("lifted_by", { mode: "number" }),
  liftedAt: timestamptz("lifted_at"),
  liftReason: text("lift_reason"),
});

export const qualityParameters = pgTable("quality_parameters", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("%"),
  decimals: smallint("decimals").notNull().default(2),
  minValid: numeric("min_valid", { precision: 9, scale: 4, mode: "number" }).notNull().default(0),
  maxValid: numeric("max_valid", { precision: 9, scale: 4, mode: "number" }).notNull().default(100),
  sortOrder: smallint("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

export const deliveryOrders = pgTable("delivery_orders", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  doNo: text("do_no").notNull(),
  doDate: date("do_date").notNull(),
  contractId: bigint("contract_id", { mode: "number" }),
  contractNo: text("contract_no"),
  customerPoNo: text("customer_po_no"),
  partnerId: bigint("partner_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  qty: numeric("qty", { precision: 16, scale: 3, mode: "number" }).notNull(),
  uom: text("uom").notNull().default("kg"),
  tolerancePct: numeric("tolerance_pct", { precision: 7, scale: 4, mode: "number" }).notNull().default(0),
  /** The master row of DOs made before migration 0008; new DOs carry the typed dest_* columns only. */
  destinationId: bigint("destination_id", { mode: "number" }),
  destName: text("dest_name"),
  destAddress: text("dest_address"),
  destDistrict: text("dest_district"),
  destRegency: text("dest_regency"),
  destProvince: text("dest_province"),
  deliveryFrom: date("delivery_from").notNull(),
  deliveryUntil: date("delivery_until"),
  transportTerms: text("transport_terms"),
  transporterId: bigint("transporter_id", { mode: "number" }),
  truckCount: smallint("truck_count"),
  truckCountBy: text("truck_count_by", { enum: ["ADMIN", "TRANSPORTER"] }),
  status: text("status", { enum: ["DRAFT", "SENT", "ACCEPTED", "CLOSED", "CANCELLED"] }).notNull().default("DRAFT"),
  remark: text("remark"),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  sentAt: timestamptz("sent_at"),
  acceptedBy: bigint("accepted_by", { mode: "number" }),
  acceptedAt: timestamptz("accepted_at"),
  closedAt: timestamptz("closed_at"),
  cancelReason: text("cancel_reason"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  // added by 0013: optional map pin of the typed destination, both set or both null
  destLat: doublePrecision("dest_lat"),
  destLon: doublePrecision("dest_lon"),
});

/** One finding of the registration checks, stored in registrations.check_findings. */
export interface Finding {
  code: string;
  message: string;
  tripSeq?: number;
  allocationSeq?: number;
}

export const registrations = pgTable("registrations", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  regNo: text("reg_no").notNull(),
  direction: text("direction", { enum: ["IN", "OUT"] }).notNull(),
  flowCode: text("flow_code", { enum: ["IN_CPO", "IN_GOODS", "OUT_BULK", "OUT_PACKED"] }).notNull(),
  partnerId: bigint("partner_id", { mode: "number" }).notNull(),
  transporterId: bigint("transporter_id", { mode: "number" }),
  status: text("status", { enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "CLOSED"] }).notNull().default("DRAFT"),
  plannedDate: date("planned_date"),
  truckCount: smallint("truck_count").notNull().default(1),
  qtyTotal: numeric("qty_total", { precision: 16, scale: 3, mode: "number" }),
  uom: text("uom").notNull().default("kg"),
  closeCargo: boolean("close_cargo"),
  flexiBag: boolean("flexi_bag"),
  remark: text("remark"),
  createdVia: text("created_via", { enum: ["PORTAL", "OPERATOR", "SCAN", "API"] }).notNull(),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  submittedAt: timestamptz("submitted_at"),
  reviewedBy: bigint("reviewed_by", { mode: "number" }),
  reviewedAt: timestamptz("reviewed_at"),
  reviewNote: text("review_note"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  // added by 0003
  checkFindings: jsonb("check_findings").$type<Finding[]>().notNull().default([]),
});

export const registrationAllocations = pgTable("registration_allocations", {
  id: id(),
  registrationId: bigint("registration_id", { mode: "number" }).notNull(),
  seq: smallint("seq").notNull(),
  contractId: bigint("contract_id", { mode: "number" }),
  deliveryOrderId: bigint("delivery_order_id", { mode: "number" }),
  qtyPlanned: numeric("qty_planned", { precision: 16, scale: 3, mode: "number" }),
  contractNo: text("contract_no").notNull(),
  doNo: text("do_no"),
  tolerancePct: numeric("tolerance_pct", { precision: 7, scale: 4, mode: "number" }).notNull().default(0),
});

export const TRIP_STATUSES = ["DRAFT", "READY", "ISSUED", "CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const trips = pgTable("trips", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  registrationId: bigint("registration_id", { mode: "number" }).notNull(),
  seq: smallint("seq").notNull().default(1),
  tripNo: text("trip_no"),
  status: text("status", { enum: TRIP_STATUSES }).notNull().default("DRAFT"),
  outcome: text("outcome", { enum: ["OK", "TRUCK_REJECT", "SPEC_REJECT", "SEAL_REJECT", "OTHER_REJECT"] }),
  vehicleId: bigint("vehicle_id", { mode: "number" }),
  driverId: bigint("driver_id", { mode: "number" }),
  transporterId: bigint("transporter_id", { mode: "number" }),
  containerNo: text("container_no"),
  plateNo: text("plate_no"),
  driverName: text("driver_name"),
  licenceNo: text("licence_no"),
  qtyPlanned: numeric("qty_planned", { precision: 16, scale: 3, mode: "number" }),
  plannedArrival: date("planned_arrival"),
  docGrossKg: integer("doc_gross_kg"),
  docTareKg: integer("doc_tare_kg"),
  docNetKg: integer("doc_net_kg"),
  grossKg: integer("gross_kg"),
  tareKg: integer("tare_kg"),
  netKg: integer("net_kg"),
  currentStep: text("current_step"),
  checkedInAt: timestamptz("checked_in_at"),
  completedAt: timestamptz("completed_at"),
  exitedAt: timestamptz("exited_at"),
  cancelledAt: timestamptz("cancelled_at"),
  cancelReason: text("cancel_reason"),
  remark: text("remark"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  // added by 0006
  deliveryNoteNo: text("delivery_note_no"),
  outSpecLetterNo: text("out_spec_letter_no"),
  // added by 0015: marked by the post at check-in; null for incoming and for trucks checked in before it
  closeCargo: boolean("close_cargo"),
  flexiBag: boolean("flexi_bag"),
  // added by 0016: free text the transporter may add per outgoing truck
  extraSpbe: text("extra_spbe"),
  passportNo: text("passport_no"),
});

export const tripAllocations = pgTable("trip_allocations", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  registrationAllocationId: bigint("registration_allocation_id", { mode: "number" }).notNull(),
  seq: smallint("seq").notNull(),
  qtyPlanned: numeric("qty_planned", { precision: 16, scale: 3, mode: "number" }),
  handoverNo: text("handover_no"),
  spbNo: text("spb_no"),
  spbDate: date("spb_date"),
  originTicketNo: text("origin_ticket_no"),
  originGrossKg: integer("origin_gross_kg"),
  originTareKg: integer("origin_tare_kg"),
  originNetKg: integer("origin_net_kg"),
  netKg: integer("net_kg"),
  qtyActual: numeric("qty_actual", { precision: 16, scale: 3, mode: "number" }),
  splitMethod: text("split_method", { enum: ["SINGLE", "PROPORTIONAL", "SEQUENTIAL", "MANUAL"] }),
  splitBy: bigint("split_by", { mode: "number" }),
  splitAt: timestamptz("split_at"),
});

export const qualityValues = pgTable("quality_values", {
  id: id(),
  parameterCode: text("parameter_code").notNull(),
  value: numeric("value", { precision: 9, scale: 4, mode: "number" }).notNull(),
  source: text("source", { enum: ["DECLARED", "QC", "LAB"] }).notNull(),
  tripAllocationId: bigint("trip_allocation_id", { mode: "number" }),
  qualityCheckId: bigint("quality_check_id", { mode: "number" }),
});

export const spjDocuments = pgTable("spj_documents", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  spjNo: text("spj_no").notNull(),
  barcodeToken: text("barcode_token").notNull(),
  issuedBy: bigint("issued_by", { mode: "number" }).notNull(),
  issuedAt: timestamptz("issued_at").notNull().defaultNow(),
  validUntil: timestamptz("valid_until"),
  printCount: integer("print_count").notNull().default(0),
  fileId: bigint("file_id", { mode: "number" }),
  revokedAt: timestamptz("revoked_at"),
  revokedBy: bigint("revoked_by", { mode: "number" }),
  revokeReason: text("revoke_reason"),
});

export const rfidCards = pgTable("rfid_cards", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  uid: text("uid").notNull(),
  label: text("label"),
  status: text("status", { enum: ["AVAILABLE", "IN_USE", "LOST", "RETIRED"] }).notNull().default("AVAILABLE"),
  note: text("note"),
});

export const cardAssignments = pgTable("card_assignments", {
  id: id(),
  cardId: bigint("card_id", { mode: "number" }).notNull(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  stationId: integer("station_id"),
  assignedBy: bigint("assigned_by", { mode: "number" }).notNull(),
  assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
  releasedBy: bigint("released_by", { mode: "number" }),
  releasedAt: timestamptz("released_at"),
  releaseReason: text("release_reason", { enum: ["CHECK_OUT", "REPLACED", "CANCELLED", "LOST"] }),
});

export const tripSteps = pgTable("trip_steps", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  stepCode: text("step_code").notNull(),
  seq: smallint("seq").notNull(),
  attempt: smallint("attempt").notNull().default(1),
  status: text("status", { enum: ["PENDING", "READY", "IN_PROGRESS", "DONE", "SKIPPED", "FAILED"] }).notNull().default("PENDING"),
  result: text("result", { enum: ["PASS", "FAIL", "HOLD"] }),
  stationId: integer("station_id"),
  performedBy: bigint("performed_by", { mode: "number" }),
  readyAt: timestamptz("ready_at"),
  startedAt: timestamptz("started_at"),
  finishedAt: timestamptz("finished_at"),
  note: text("note"),
});

// --- Phase 4: stations, weighings, exceptions ---

export const zones = pgTable("zones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  siteId: smallint("site_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  color: text("color"),
  mapShape: jsonb("map_shape"),
  capacity: smallint("capacity"),
  sortOrder: smallint("sort_order").notNull().default(0),
});

export const STATION_KINDS = ["REGISTRATION", "GATE", "WEIGHBRIDGE", "QC", "STAGING", "UNLOADING_BAY", "LOADING_BAY", "DOCK", "SEALING"] as const;

export const stations = pgTable("stations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  siteId: smallint("site_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: STATION_KINDS }).notNull(),
  zoneId: integer("zone_id"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  apiKeyHash: text("api_key_hash"),
  isActive: boolean("is_active").notNull().default(true),
  // added by 0005
  pinHash: text("pin_hash"),
  pinFailedCount: smallint("pin_failed_count").notNull().default(0),
  pinLockedUntil: timestamptz("pin_locked_until"),
  keyCreatedAt: timestamptz("key_created_at"),
});

export const weighings = pgTable("weighings", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  stationId: integer("station_id").notNull(),
  stage: smallint("stage").notNull(),
  kind: text("kind", { enum: ["GROSS", "TARE"] }).notNull(),
  weightKg: integer("weight_kg").notNull(),
  rawReading: text("raw_reading"),
  weighedAt: timestamptz("weighed_at").notNull().defaultNow(),
  mode: text("mode", { enum: ["AUTO", "EXCEPTION"] }).notNull().default("AUTO"),
  cardUid: text("card_uid"),
  plateRead: text("plate_read"),
  plateConfidence: numeric("plate_confidence", { precision: 5, scale: 4, mode: "number" }),
  plateCheck: text("plate_check", { enum: ["MATCH", "CONFIRMED", "BYPASSED"] }).notNull(),
  status: text("status", { enum: ["PENDING", "VALID", "VOID"] }).notNull().default("VALID"),
  voidReason: text("void_reason"),
  voidedBy: bigint("voided_by", { mode: "number" }),
  voidedAt: timestamptz("voided_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const EXCEPTION_TYPES = ["PLATE", "GROSS_IN", "TARE_OUT", "NET_IN", "NET_OUT", "QC_HOLD"] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
export const EXCEPTION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "RETRY", "CANCELLED", "EXPIRED"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const exceptionRules = pgTable("exception_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  siteId: smallint("site_id").notNull(),
  type: text("type", { enum: EXCEPTION_TYPES }).notNull(),
  flowCode: text("flow_code"),
  thresholdPct: numeric("threshold_pct", { precision: 7, scale: 4, mode: "number" }),
  thresholdKg: integer("threshold_kg"),
  onExceed: text("on_exceed", { enum: ["WARN", "APPROVAL", "BLOCK"] }).notNull().default("APPROVAL"),
  escalateAfterS: integer("escalate_after_s"),
  isActive: boolean("is_active").notNull().default(true),
  validFrom: date("valid_from").notNull().defaultNow(),
  // added by 0004
  approverModule: text("approver_module").notNull(),
  escalateModule: text("escalate_module"),
});

export const exceptions = pgTable("exceptions", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  weighingId: bigint("weighing_id", { mode: "number" }),
  qualityCheckId: bigint("quality_check_id", { mode: "number" }),
  type: text("type", { enum: EXCEPTION_TYPES }).notNull(),
  status: text("status", { enum: EXCEPTION_STATUSES }).notNull().default("PENDING"),
  // NET_OUT: OK, ADD_LOAD, REDUCE_LOAD; other weighbridge requests decided REJECTED: HOLD or REJECT (0016)
  decisionCode: text("decision_code", { enum: ["OK", "ADD_LOAD", "REDUCE_LOAD", "HOLD", "REJECT"] }),
  expectedValue: numeric("expected_value", { precision: 16, scale: 3, mode: "number" }),
  actualValue: numeric("actual_value", { precision: 16, scale: 3, mode: "number" }),
  diffValue: numeric("diff_value", { precision: 16, scale: 3, mode: "number" }),
  diffPct: numeric("diff_pct", { precision: 9, scale: 4, mode: "number" }),
  tolerancePct: numeric("tolerance_pct", { precision: 7, scale: 4, mode: "number" }),
  liveWeightKg: integer("live_weight_kg"),
  liveWeightAt: timestamptz("live_weight_at"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  raisedAt: timestamptz("raised_at").notNull().defaultNow(),
  reminderCount: smallint("reminder_count").notNull().default(0),
  lastRemindedAt: timestamptz("last_reminded_at"),
  escalatedAt: timestamptz("escalated_at"),
  decidedBy: bigint("decided_by", { mode: "number" }),
  decidedAt: timestamptz("decided_at"),
  decisionReason: text("decision_reason"),
  reportNo: text("report_no"),
  reportFileId: bigint("report_file_id", { mode: "number" }),
  // added by 0004
  approverModule: text("approver_module").notNull(),
  escalatedModule: text("escalated_module"),
  // added by 0005
  stationId: integer("station_id"),
});

// --- Phase 5: notifications (tables from 0001, created_at of a delivery from 0014) ---

export const DEVICE_PLATFORMS = ["ANDROID", "IOS", "WEB"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** One installed app that receives pushes: its FCM token belongs to the account last signed in on it. */
export const userDevices = pgTable("user_devices", {
  id: id(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  platform: text("platform", { enum: DEVICE_PLATFORMS }).notNull(),
  pushToken: text("push_token").notNull(),
  appVersion: text("app_version"),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
});

export const NOTIFICATION_SEVERITIES = ["INFO", "WARNING", "ALARM"] as const;

export const notifications = pgTable("notifications", {
  id: id(),
  siteId: smallint("site_id"),
  type: text("type").notNull(),
  severity: text("severity", { enum: NOTIFICATION_SEVERITIES }).notNull().default("INFO"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  exceptionId: bigint("exception_id", { mode: "number" }),
  tripId: bigint("trip_id", { mode: "number" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** One recipient of a notification: its inbox entry (IN_APP) or one push to one device (PUSH). */
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: id(),
  notificationId: bigint("notification_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  deviceId: bigint("device_id", { mode: "number" }),
  channel: text("channel", { enum: ["PUSH", "IN_APP"] }).notNull(),
  sentAt: timestamptz("sent_at"),
  providerRef: text("provider_ref"),
  error: text("error"),
  readAt: timestamptz("read_at"),
  // added by 0014
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const weighbridgeRequests = pgTable("weighbridge_requests", {
  stationId: integer("station_id").notNull(),
  requestId: text("request_id").notNull(),
  tripId: bigint("trip_id", { mode: "number" }),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  result: text("result", { enum: ["SAVED", "PENDING", "PLATE_RETRY"] }).notNull(),
  statusCode: smallint("status_code").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// --- Phase 5: plant masters, files, field forms ---

export const productQualitySpecs = pgTable("product_quality_specs", {
  id: id(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  parameterCode: text("parameter_code").notNull(),
  minValue: numeric("min_value", { precision: 9, scale: 4, mode: "number" }),
  maxValue: numeric("max_value", { precision: 9, scale: 4, mode: "number" }),
  onFail: text("on_fail", { enum: ["INFO", "HOLD", "REJECT"] }).notNull().default("HOLD"),
  validFrom: date("valid_from").notNull().defaultNow(),
});

export const storageTanks = pgTable("storage_tanks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  siteId: smallint("site_id").notNull(),
  code: text("code").notNull(),
  name: text("name"),
  productId: bigint("product_id", { mode: "number" }),
  capacityKg: bigint("capacity_kg", { mode: "number" }),
  erpRef: text("erp_ref"),
  isActive: boolean("is_active").notNull().default(true),
  productLabel: text("product_label"),
  erpRemovedAt: timestamptz("erp_removed_at"),
});

export const SEAL_KINDS = ["LOCIS", "CUSTOMS"] as const;
export const SEAL_STATUSES = ["AVAILABLE", "USED", "VOID"] as const;

export const seals = pgTable("seals", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  sealNo: text("seal_no").notNull(),
  kind: text("kind", { enum: SEAL_KINDS }).notNull().default("LOCIS"),
  status: text("status", { enum: SEAL_STATUSES }).notNull().default("AVAILABLE"),
  batchRef: text("batch_ref"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const files = pgTable("files", {
  id: id(),
  storageKey: text("storage_key").notNull(),
  originalName: text("original_name"),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  kind: text("kind", { enum: ["PHOTO", "SCAN", "PDF", "OTHER"] }).notNull(),
  capturedAt: timestamptz("captured_at"),
  uploadedBy: bigint("uploaded_by", { mode: "number" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const tripFiles = pgTable("trip_files", {
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  fileId: bigint("file_id", { mode: "number" }).notNull(),
  weighingId: bigint("weighing_id", { mode: "number" }),
  stepCode: text("step_code"),
  label: text("label"),
  addedBy: bigint("added_by", { mode: "number" }),
  addedAt: timestamptz("added_at"),
});

/** What the reading service made of a scan of the registration post (0015). NOT_READ: the service did not answer. */
export const GATE_SCAN_OUTCOMES = ["READ", "UNREADABLE", "NOT_READ"] as const;
export const gateScans = pgTable("gate_scans", {
  fileId: bigint("file_id", { mode: "number" }).primaryKey(),
  direction: text("direction", { enum: ["IN", "OUT"] }).notNull(),
  outcome: text("outcome", { enum: GATE_SCAN_OUTCOMES }).notNull(),
  fieldsFound: smallint("fields_found"),
  fieldsTotal: smallint("fields_total"),
});

export const deliveryOrderFiles = pgTable("delivery_order_files", {
  deliveryOrderId: bigint("delivery_order_id", { mode: "number" }).notNull(),
  fileId: bigint("file_id", { mode: "number" }).notNull(),
  label: text("label"),
  addedBy: bigint("added_by", { mode: "number" }).notNull(),
  addedAt: timestamptz("added_at").notNull().defaultNow(),
});

export const SHIPMENT_REQUEST_STATUSES = ["DRAFT", "SENT", "CLOSED", "CANCELLED"] as const;

/** Added by 0017: a request to a supplier to deliver on one purchase contract. */
export const shipmentRequests = pgTable("shipment_requests", {
  id: id(),
  siteId: smallint("site_id").notNull(),
  contractId: bigint("contract_id", { mode: "number" }).notNull(),
  contractNo: text("contract_no").notNull(),
  partnerId: bigint("partner_id", { mode: "number" }).notNull(),
  qtyPlanned: numeric("qty_planned", { precision: 16, scale: 3, mode: "number" }),
  deliveryFrom: date("delivery_from"),
  deliveryUntil: date("delivery_until"),
  remark: text("remark"),
  status: text("status", { enum: SHIPMENT_REQUEST_STATUSES }).notNull().default("DRAFT"),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  sentBy: bigint("sent_by", { mode: "number" }),
  sentAt: timestamptz("sent_at"),
  closedBy: bigint("closed_by", { mode: "number" }),
  closedAt: timestamptz("closed_at"),
  cancelledBy: bigint("cancelled_by", { mode: "number" }),
  cancelledAt: timestamptz("cancelled_at"),
  cancelReason: text("cancel_reason"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const shipmentRequestFiles = pgTable("shipment_request_files", {
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).notNull(),
  fileId: bigint("file_id", { mode: "number" }).notNull(),
  label: text("label"),
  addedBy: bigint("added_by", { mode: "number" }).notNull(),
  addedAt: timestamptz("added_at").notNull().defaultNow(),
});

export const qualityChecks = pgTable("quality_checks", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  stage: text("stage", { enum: ["RECEIVING", "LOADING"] }).notNull(),
  method: text("method", { enum: ["MANUAL", "DIP_PROBE", "AUTO_SAMPLER", "LAB"] }).notNull().default("MANUAL"),
  deviceRef: text("device_ref"),
  tankId: integer("tank_id"),
  sampledBy: bigint("sampled_by", { mode: "number" }),
  sampledAt: timestamptz("sampled_at").notNull().defaultNow(),
  decision: text("decision", { enum: ["PASS", "HOLD", "REJECT"] }),
  decidedBy: bigint("decided_by", { mode: "number" }),
  decidedAt: timestamptz("decided_at"),
  remark: text("remark"),
  clientUuid: uuid("client_uuid"),
  // added by 0006
  disposition: text("disposition", { enum: ["OK", "HOLD", "NOT_OK"] }),
  reasonCode: text("reason_code", { enum: ["FFA_OUT", "MI_OUT", "FFA_MI_OUT"] }),
  certificateNo: text("certificate_no"),
});

/** One line of an inspection checklist: a stable key, the label shown to the operator, and the answer. */
export interface ChecklistItem {
  key: string;
  item: string;
  ok?: boolean | null;
  value?: unknown;
  note?: string | null;
}

export const inspections = pgTable("inspections", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  kind: text("kind", { enum: ["SEAL_CHECK", "TANK_EMPTY", "CLEANLINESS", "TRUCK_CONDITION"] }).notNull(),
  result: text("result", { enum: ["PASS", "FAIL"] }).notNull(),
  checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
  performedBy: bigint("performed_by", { mode: "number" }).notNull(),
  performedAt: timestamptz("performed_at").notNull().defaultNow(),
  remark: text("remark"),
  clientUuid: uuid("client_uuid"),
});

export const handlings = pgTable("handlings", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  kind: text("kind", { enum: ["UNLOAD", "LOAD"] }).notNull(),
  tankId: integer("tank_id"),
  stationId: integer("station_id"),
  startedAt: timestamptz("started_at"),
  finishedAt: timestamptz("finished_at"),
  temperatureC: numeric("temperature_c", { precision: 5, scale: 1, mode: "number" }),
  qtyMeter: numeric("qty_meter", { precision: 16, scale: 3, mode: "number" }),
  operatorId: bigint("operator_id", { mode: "number" }).notNull(),
  logSheet: jsonb("log_sheet").$type<Record<string, unknown>>().notNull().default({}),
  remark: text("remark"),
  clientUuid: uuid("client_uuid"),
});

export const tripSeals = pgTable("trip_seals", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  sealNo: text("seal_no").notNull(),
  kind: text("kind", { enum: SEAL_KINDS }).notNull().default("LOCIS"),
  origin: text("origin", { enum: ["DECLARED", "APPLIED"] }).notNull(),
  position: text("position"),
  sealId: bigint("seal_id", { mode: "number" }),
  photoFileId: bigint("photo_file_id", { mode: "number" }),
  appliedBy: bigint("applied_by", { mode: "number" }),
  appliedAt: timestamptz("applied_at"),
  removedAt: timestamptz("removed_at"),
  removeReason: text("remove_reason"),
  // added by 0006
  tripStepId: bigint("trip_step_id", { mode: "number" }),
  removedBy: bigint("removed_by", { mode: "number" }),
});

export const FIELD_FORMS = ["SEAL_CHECK", "QC_RECEIVING", "RESEAL", "UNLOADING", "CLEANLINESS", "QC_LOADING", "LOADING_START", "LOADING_FINISH", "SEALING"] as const;
export type FieldForm = (typeof FIELD_FORMS)[number];

export const fieldSubmissions = pgTable("field_submissions", {
  clientUuid: uuid("client_uuid").primaryKey(),
  tripStepId: bigint("trip_step_id", { mode: "number" }).notNull(),
  form: text("form", { enum: FIELD_FORMS }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// Phase 8 (0011): positions of vehicles outside the plant.
export const GPS_SOURCE_KINDS = ["PROVIDER", "DEVICE"] as const;
export const POSITION_SOURCE_KINDS = ["DEVICE", "PHONE"] as const;
export type PositionSourceKind = (typeof POSITION_SOURCE_KINDS)[number];

export const gpsSources = pgTable("gps_sources", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind", { enum: GPS_SOURCE_KINDS }).notNull(),
  keyHash: text("key_hash"),
  keyCreatedAt: timestamptz("key_created_at"),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamptz("last_seen_at"),
  createdBy: bigint("created_by", { mode: "number" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const vehicleTrackers = pgTable("vehicle_trackers", {
  id: id(),
  vehicleId: bigint("vehicle_id", { mode: "number" }).notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  deviceId: text("device_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  attachedBy: bigint("attached_by", { mode: "number" }),
  attachedAt: timestamptz("attached_at").notNull().defaultNow(),
  detachedBy: bigint("detached_by", { mode: "number" }),
  detachedAt: timestamptz("detached_at"),
});

export const gpsUnknownDevices = pgTable("gps_unknown_devices", {
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  deviceId: text("device_id").notNull(),
  firstSeenAt: timestamptz("first_seen_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  lastPointAt: timestamptz("last_point_at").notNull(),
  pointCount: integer("point_count").notNull().default(0),
});

export const vehiclePositions = pgTable("vehicle_positions", {
  id: id(),
  vehicleId: bigint("vehicle_id", { mode: "number" }).notNull(),
  tripId: bigint("trip_id", { mode: "number" }),
  at: timestamptz("at").notNull(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  speedKph: real("speed_kph"),
  headingDeg: real("heading_deg"),
  accuracyM: real("accuracy_m"),
  sourceKind: text("source_kind", { enum: POSITION_SOURCE_KINDS }).notNull(),
  sourceId: bigint("source_id", { mode: "number" }),
  receivedAt: timestamptz("received_at").notNull().defaultNow(),
});

export const vehicleLastPositions = pgTable("vehicle_last_positions", {
  vehicleId: bigint("vehicle_id", { mode: "number" }).primaryKey(),
  tripId: bigint("trip_id", { mode: "number" }),
  at: timestamptz("at").notNull(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  speedKph: real("speed_kph"),
  headingDeg: real("heading_deg"),
  accuracyM: real("accuracy_m"),
  sourceKind: text("source_kind", { enum: POSITION_SOURCE_KINDS }).notNull(),
  receivedAt: timestamptz("received_at").notNull(),
});

export const tripShareLinks = pgTable("trip_share_links", {
  id: id(),
  tripId: bigint("trip_id", { mode: "number" }).notNull(),
  tokenHash: text("token_hash"),
  createdBy: bigint("created_by", { mode: "number" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  revokedAt: timestamptz("revoked_at"),
  revokedBy: bigint("revoked_by", { mode: "number" }),
});
