// Drizzle definitions of the tables this slice reads and writes. The SQL files in `migrations/` are the
// source of truth; test/schema-drift.test.ts fails when a definition here no longer matches the database.
// Constraints (checks, unique indexes, foreign keys) live in the migrations only.
import { bigint, boolean, date, inet, integer, jsonb, numeric, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

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
  destinationId: bigint("destination_id", { mode: "number" }).notNull(),
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
