// Made-up master data for the registration, DO, SPJ and gate tests. Every name and number here is invented.
import type { FastifyInstance } from "fastify";
import type { Database } from "../../src/db/client.js";
import { testApp } from "./app.js";
import type { Permissions } from "../../src/auth/permissions.js";
import { bearer, DESK, grant, LOGISTICS, seedPartner, seedPartnerUser, seedStaff, VIEWER } from "./users.js";

const one = async (database: Database, text: string, params: unknown[]) => Number((await database.query<{ id: number }>(text, params))[0]?.id);

let erpRef = 1000;

export async function seedProduct(database: Database, name: string, category: string, uom = "kg"): Promise<number> {
  erpRef++;
  return one(database, "insert into products (erp_system, erp_ref, name, category, uom) values ('ODOO', $1, $2, $3, $4) returning id", [String(erpRef), name, category, uom]);
}

export async function seedCompany(database: Database, name: string, flags: { transporter?: boolean; supplier?: boolean; customer?: boolean } = {}): Promise<number> {
  return one(database, "insert into partners (name, is_transporter, is_supplier, is_customer) values ($1, $2, $3, $4) returning id", [
    name,
    flags.transporter ?? false,
    flags.supplier ?? false,
    flags.customer ?? false,
  ]);
}

export interface ContractSeed {
  no: string;
  partnerId: number;
  productId: number;
  direction?: "IN" | "OUT";
  qty?: number | null;
  opening?: number;
  state?: "OPEN" | "CLOSED" | "CANCELLED";
  uom?: string;
  tolerancePct?: number;
  customerPoNo?: string | null;
}

export async function seedContract(database: Database, seed: ContractSeed): Promise<number> {
  erpRef++;
  return one(
    database,
    `insert into erp_contracts (erp_system, erp_ref, direction, contract_no, partner_id, product_id, qty_contract, qty_opening, uom, tolerance_pct, customer_po_no, state)
     values ('ODOO', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      `line,${erpRef}`, seed.direction ?? "IN", seed.no, seed.partnerId, seed.productId, seed.qty === undefined ? 100_000 : seed.qty, seed.opening ?? 0,
      seed.uom ?? "kg", seed.tolerancePct ?? 0, seed.customerPoNo ?? null, seed.state ?? "OPEN",
    ],
  );
}

/** A typed destination as a DO carries it since migration 0008. */
export const DESTINATION = {
  destName: "Gudang Contoh",
  destAddress: "Jl. Contoh 1",
  destDistrict: "Kec. Contoh",
  destRegency: "Kab. Contoh",
  destProvince: "Prov. Contoh",
};

export async function seedDestination(database: Database, name: string, partnerId: number | null = null): Promise<number> {
  return one(database, "insert into destinations (partner_id, name, address, district, regency, province) values ($1, $2, 'Jl. Contoh 1', 'Kec. Contoh', 'Kab. Contoh', 'Prov. Contoh') returning id", [partnerId, name]);
}

export interface VehicleSeed {
  plate: string;
  type?: string;
  ownerId?: number | null;
  capacityKg?: number | null;
  verified?: boolean;
  stnk?: string | null;
  tax?: string | null;
  kir?: string | null;
}

export async function seedVehicle(database: Database, seed: VehicleSeed): Promise<number> {
  return one(
    database,
    `insert into vehicles (plate_no, plate_display, vehicle_type_code, owner_partner_id, capacity_kg, stnk_valid_until, tax_valid_until, kir_valid_until, verified_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      seed.plate.replace(/\s/g, ""), seed.plate, seed.type ?? "TANGKI", seed.ownerId ?? null, seed.capacityKg ?? null,
      seed.stnk === undefined ? "2027-12-31" : seed.stnk, seed.tax === undefined ? "2027-12-31" : seed.tax, seed.kir === undefined ? "2027-12-31" : seed.kir,
      seed.verified === false ? null : "2026-01-01T00:00:00Z",
    ],
  );
}

export interface DriverSeed {
  name: string;
  licence: string;
  status?: "UNKNOWN" | "NORMAL" | "WARNING" | "BLACKLIST";
  validUntil?: string | null;
}

export async function seedDriver(database: Database, seed: DriverSeed): Promise<number> {
  return one(
    database,
    "insert into drivers (full_name, licence_no, licence_class, licence_valid_until, registry_status) values ($1, $2, 'B2 UMUM', $3, $4) returning id",
    [seed.name, seed.licence, seed.validUntil === undefined ? "2028-01-31" : seed.validUntil, seed.status ?? "NORMAL"],
  );
}

export async function seedCard(database: Database, uid: string, label: string | null = null, status = "AVAILABLE"): Promise<number> {
  return one(database, "insert into rfid_cards (site_id, uid, label, status) select id, $1, $2, $3 from sites order by id limit 1 returning id", [uid, label, status]);
}

export async function siteCode(database: Database): Promise<string> {
  return String((await database.query<{ code: string }>("select code from sites order by id limit 1"))[0]?.code);
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Phase3User = "logistics" | "pos" | "qc" | "pks1" | "pks2" | "angkut1" | "angkut2";

/**
 * An application with the accounts the phase 3 tests use:
 * logistics (LOGISTICS), pos (DESK), qc (VIEWER: reads, writes nothing),
 * pks1 / pks2 (accounts of supplier1 / supplier2), angkut1 / angkut2 (accounts of transporter1 / transporter2); the
 * partner accounts have the defaults their companies give. `permissions` replaces what an account holds.
 */
export async function phase3App(env: Record<string, string> = {}, permissions: Partial<Record<Phase3User, Permissions>> = {}) {
  const context = await testApp(env);
  const { app, database } = context;
  const supplier1 = await seedCompany(database, "PT Sawit Satu", { supplier: true });
  const supplier2 = await seedCompany(database, "PT Sawit Dua", { supplier: true });
  const customer1 = await seedCompany(database, "PT Pembeli Satu", { customer: true });
  const customer2 = await seedCompany(database, "PT Pembeli Dua", { customer: true });
  const transporter1 = await seedCompany(database, "PT Angkut Satu", { transporter: true });
  const transporter2 = await seedCompany(database, "PT Angkut Dua", { transporter: true });
  const ids = {
    logistics: await seedStaff(database, "logistics", LOGISTICS),
    pos: await seedStaff(database, "pos", DESK),
    qc: await seedStaff(database, "qc", VIEWER),
    pks1: await seedPartnerUser(database, "pks1", supplier1),
    pks2: await seedPartnerUser(database, "pks2", supplier2),
    angkut1: await seedPartnerUser(database, "angkut1", transporter1),
    angkut2: await seedPartnerUser(database, "angkut2", transporter2),
  };
  for (const [name, wanted] of Object.entries(permissions)) await grant(database, ids[name as Phase3User], wanted);
  const cpo = await seedProduct(database, "Minyak Contoh Mentah", "CPO");
  const olein = await seedProduct(database, "Minyak Contoh Olahan", "BULK_LIQUID");
  const packed = await seedProduct(database, "Minyak Contoh Kemasan", "PACKED", "karton");
  // access tokens live 15 minutes on the test clock: sign in again once the clock moved on
  const tokens = new Map<string, { headers: { authorization: string }; at: number }>();
  const headersOf = async (username: string) => {
    const now = context.clock.now().getTime();
    const known = tokens.get(username);
    if (known && now - known.at < 10 * 60_000) return known.headers;
    const headers = await bearer(app, username);
    tokens.set(username, { headers, at: now });
    return headers;
  };
  const call = async (method: Method, url: string, username: string | null = "logistics", payload?: object) =>
    (app as FastifyInstance).inject({ method, url, headers: username ? await headersOf(username) : {}, ...(payload ? { payload } : {}) });
  return {
    ...context,
    ids,
    companies: { supplier1, supplier2, customer1, customer2, transporter1, transporter2 },
    products: { cpo, olein, packed },
    call,
    seed: { seedPartner, seedPartnerUser, seedStaff },
  };
}
