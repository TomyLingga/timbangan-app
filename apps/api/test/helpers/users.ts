import type { FastifyInstance } from "fastify";
import { type Permissions, replacePermissions } from "../../src/auth/permissions.js";
import type { Database } from "../../src/db/client.js";
import { createUser } from "../../src/users/create-user.js";

export const PASSWORD = "s3cret-s3cret";

/** EDIT on every active module. */
export const EVERYTHING: Permissions = {
  contracts: "EDIT", drivers: "EDIT", vehicles: "EDIT", delivery_orders: "EDIT", registrations: "EDIT", gate: "EDIT", rfid_cards: "EDIT", users: "EDIT",
  weighbridge: "EDIT", approvals: "EDIT", qc: "EDIT", qc_approvals: "EDIT", security_check: "EDIT", unloading: "EDIT", loading: "EDIT", sealing: "EDIT", reports: "VIEW", plant_masters: "EDIT",
};
/** The logistics office: everything except the user administration. */
export const LOGISTICS: Permissions = {
  contracts: "EDIT", drivers: "EDIT", vehicles: "EDIT", delivery_orders: "EDIT", registrations: "EDIT", gate: "EDIT", rfid_cards: "EDIT",
};
/** Reads the master data, DOs and registrations, and changes nothing. */
export const VIEWER: Permissions = {
  contracts: "VIEW", drivers: "VIEW", vehicles: "VIEW", delivery_orders: "VIEW", registrations: "VIEW",
};
/** The registration desk. */
export const DESK: Permissions = { gate: "EDIT", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" };
/** What a supplier company's account gets by default. */
export const SUPPLIER: Permissions = { contracts: "VIEW", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" };
/** What a transporter or customer company's account gets by default. */
export const TRANSPORTER: Permissions = { delivery_orders: "EDIT", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" };

export interface PartnerFlags {
  erpRef?: string;
  supplier?: boolean;
  transporter?: boolean;
  customer?: boolean;
}

export async function seedPartner(database: Database, name: string, flags: PartnerFlags = {}): Promise<number> {
  const [row] = await database.query<{ id: number }>(
    "insert into partners (name, erp_system, erp_ref, is_supplier, is_transporter, is_customer) values ($1, $2, $3, $4, $5, $6) returning id",
    [name, flags.erpRef ? "ODOO" : null, flags.erpRef ?? null, flags.supplier ?? false, flags.transporter ?? false, flags.customer ?? false],
  );
  return Number(row?.id);
}

/** Makes the user's permissions exactly these. */
export async function grant(database: Database, userId: number, permissions: Permissions): Promise<void> {
  await replacePermissions(database.db, userId, permissions, null, new Date());
}

/** A staff account that signs in with PASSWORD, with exactly these permissions. */
export async function seedStaff(database: Database, username: string, permissions: Permissions = LOGISTICS): Promise<number> {
  const { id } = await createUser(database.db, { username, fullName: `Staff ${username}`, kind: "INTERNAL", password: PASSWORD });
  await grant(database, id, permissions);
  return id;
}

/**
 * A partner account of the given company that signs in with PASSWORD. Without `permissions` it keeps the
 * defaults its company's flags give it.
 */
export async function seedPartnerUser(database: Database, username: string, partnerId: number, permissions?: Permissions): Promise<number> {
  const { id } = await createUser(database.db, { username, fullName: `Partner ${username}`, kind: "PARTNER", partnerId, password: PASSWORD });
  if (permissions) await grant(database, id, permissions);
  return id;
}

/** Signs in and answers the header that authorises the next requests. */
export async function bearer(app: FastifyInstance, username: string): Promise<{ authorization: string }> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
  if (response.statusCode !== 200) throw new Error(`login of ${username} failed: ${response.body}`);
  return { authorization: `Bearer ${(response.json() as { accessToken: string }).accessToken}` };
}
