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

export const roles = pgTable("roles", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  scope: text("scope", { enum: ["INTERNAL", "PARTNER"] }).notNull(),
});

export const userRoles = pgTable("user_roles", {
  userId: bigint("user_id", { mode: "number" }).notNull(),
  roleCode: text("role_code").notNull(),
  siteId: smallint("site_id"),
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
