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
