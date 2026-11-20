import type { FastifyInstance } from "fastify";
import type { Database } from "../../src/db/client.js";
import { createUser } from "../../src/users/create-user.js";

export const PASSWORD = "s3cret-s3cret";

export async function seedPartner(database: Database, name: string, flags: { erpRef?: string } = {}): Promise<number> {
  const [row] = await database.query<{ id: number }>(
    "insert into partners (name, erp_system, erp_ref) values ($1, $2, $3) returning id",
    [name, flags.erpRef ? "ODOO" : null, flags.erpRef ?? null],
  );
  return Number(row?.id);
}

/** A staff account that signs in with PASSWORD. */
export async function seedStaff(database: Database, username: string, role = "LOGISTICS_ADMIN"): Promise<number> {
  return (await createUser(database.db, { username, fullName: `Staff ${username}`, kind: "INTERNAL", role, password: PASSWORD })).id;
}

/** A partner account of the given company that signs in with PASSWORD. */
export async function seedPartnerUser(database: Database, username: string, partnerId: number, role = "PARTNER_SUPPLIER"): Promise<number> {
  return (await createUser(database.db, { username, fullName: `Partner ${username}`, kind: "PARTNER", partnerId, role, password: PASSWORD })).id;
}

/** Signs in and answers the header that authorises the next requests. */
export async function bearer(app: FastifyInstance, username: string): Promise<{ authorization: string }> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
  if (response.statusCode !== 200) throw new Error(`login of ${username} failed: ${response.body}`);
  return { authorization: `Bearer ${(response.json() as { accessToken: string }).accessToken}` };
}
