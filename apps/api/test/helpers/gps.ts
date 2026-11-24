// Made-up companies, vehicles and trips for the GPS tests. Trips are written straight into the tables, so a test can put
// a truck in any state. Every name, plate and number here is invented; coordinates lie in the open sea.
import type { FastifyInstance } from "fastify";
import type { Permissions } from "../../src/auth/permissions.js";
import type { Database } from "../../src/db/client.js";
import { testApp } from "./app.js";
import { seedCompany, seedProduct } from "./fixtures.js";
import { bearer, seedPartnerUser, seedStaff } from "./users.js";

/** A point in the open Indian Ocean, far from any coast. */
export const SEA = { lat: -10.5, lon: 85.25 };

const one = async (database: Database, text: string, params: unknown[]) => Number((await database.query<{ id: number }>(text, params))[0]?.id);

let counter = 0;

export type SeedTripStatus = "DRAFT" | "ISSUED" | "CHECKED_IN" | "IN_PROCESS" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface GpsTripSeed {
  direction: "IN" | "OUT";
  /** The supplier of an incoming trip, the customer of the DO of an outgoing one. */
  partnerId: number;
  vehicleId: number;
  status: SeedTripStatus;
  transporterId?: number | null;
  exitedAt?: string | null;
  /** The SPJ's end; null: no SPJ at all. Defaults to a week after the test clock's start. */
  spjValidUntil?: string | null;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * An application with: staff lacak (gps EDIT), lihat (gps VIEW), logistik (no gps); partner accounts with gps VIEW:
 * pks1 / pks2 (suppliers), beli1 / beli2 (customers), angkut1 / angkut2 (transporters), and angkut3 of transporter1
 * without gps.
 */
export async function gpsApp(env: Record<string, string> = {}) {
  const context = await testApp(env);
  const { app, database, clock } = context;
  const companies = {
    supplier1: await seedCompany(database, "PT Kebun Contoh Satu", { supplier: true }),
    supplier2: await seedCompany(database, "PT Kebun Contoh Dua", { supplier: true }),
    customer1: await seedCompany(database, "PT Pembeli Contoh Satu", { customer: true }),
    customer2: await seedCompany(database, "PT Pembeli Contoh Dua", { customer: true }),
    transporter1: await seedCompany(database, "PT Angkutan Contoh Satu", { transporter: true }),
    transporter2: await seedCompany(database, "PT Angkutan Contoh Dua", { transporter: true }),
  };
  const view: Permissions = { gps: "VIEW" };
  const ids = {
    lacak: await seedStaff(database, "lacak", { gps: "EDIT" }),
    lihat: await seedStaff(database, "lihat", { gps: "VIEW" }),
    logistik: await seedStaff(database, "logistik", { registrations: "EDIT", gate: "EDIT", vehicles: "EDIT" }),
    pks1: await seedPartnerUser(database, "pks1", companies.supplier1, view),
    pks2: await seedPartnerUser(database, "pks2", companies.supplier2, view),
    beli1: await seedPartnerUser(database, "beli1", companies.customer1, view),
    beli2: await seedPartnerUser(database, "beli2", companies.customer2, view),
    angkut1: await seedPartnerUser(database, "angkut1", companies.transporter1, { ...view, vehicles: "CREATE", registrations: "CREATE" }),
    angkut2: await seedPartnerUser(database, "angkut2", companies.transporter2, view),
    angkut3: await seedPartnerUser(database, "angkut3", companies.transporter1, { vehicles: "CREATE" }),
  };
  const product = await seedProduct(database, "Minyak Contoh Lacak", "CPO");

  const tokens = new Map<string, { headers: { authorization: string }; at: number }>();
  const headersOf = async (username: string) => {
    const now = clock.now().getTime();
    const known = tokens.get(username);
    if (known && Math.abs(now - known.at) < 10 * 60_000) return known.headers;
    const headers = await bearer(app, username);
    tokens.set(username, { headers, at: now });
    return headers;
  };
  /** A request as `username`; null: without an account. */
  const call = async (method: Method, url: string, username: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
    (app as FastifyInstance).inject({
      method,
      url,
      headers: { ...(username ? await headersOf(username) : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const vehicle = (plate: string, ownerId: number | null = null) =>
    one(database, "insert into vehicles (plate_no, plate_display, vehicle_type_code, owner_partner_id) values ($1, $2, 'TANGKI', $3) returning id", [
      plate.replace(/\s/g, ""),
      plate,
      ownerId,
    ]);

  const trip = async (seed: GpsTripSeed): Promise<number> => {
    counter++;
    const site = await one(database, "select id from sites order by id limit 1", []);
    const transporterId = seed.transporterId === undefined ? companies.transporter1 : seed.transporterId;
    const contractId = await one(
      database,
      `insert into erp_contracts (erp_system, erp_ref, direction, contract_no, partner_id, product_id, qty_contract, state)
       values ('ODOO', $1, $2, $3, $4, $5, 100000, 'OPEN') returning id`,
      [`gps,${counter}`, seed.direction, `KTR-GPS-${counter}`, seed.partnerId, product],
    );
    let doId: number | null = null;
    if (seed.direction === "OUT") {
      doId = await one(
        database,
        `insert into delivery_orders (site_id, do_no, do_date, contract_id, contract_no, partner_id, product_id, qty, delivery_from, transporter_id, status,
                                      created_by, dest_name, dest_regency)
         values ($1, $2, '2026-11-19', $3, $4, $5, $6, 30000, '2026-11-19', $7, 'ACCEPTED', $8, 'Gudang Contoh', 'Kab. Contoh') returning id`,
        [site, `DO-GPS-${counter}`, contractId, `KTR-GPS-${counter}`, seed.partnerId, product, transporterId ?? companies.transporter1, ids.logistik],
      );
    }
    const registrationId = await one(
      database,
      `insert into registrations (site_id, reg_no, direction, flow_code, partner_id, transporter_id, status, created_via, created_by, close_cargo, flexi_bag)
       values ($1, $2, $3, $4, $5, $6, 'APPROVED', 'OPERATOR', $7, false, false) returning id`,
      [site, `REG-GPS-${counter}`, seed.direction, seed.direction === "IN" ? "IN_CPO" : "OUT_BULK", seed.partnerId, transporterId, ids.logistik],
    );
    const allocationId = await one(
      database,
      `insert into registration_allocations (registration_id, seq, contract_id, delivery_order_id, contract_no, do_no)
       values ($1, 1, $2, $3, $4, $5) returning id`,
      [registrationId, seed.direction === "IN" ? contractId : null, doId, `KTR-GPS-${counter}`, doId === null ? null : `DO-GPS-${counter}`],
    );
    const driverId = await one(database, "insert into drivers (full_name, licence_no) values ($1, $2) returning id", [`Supir Contoh ${counter}`, `SIMGPS${String(counter).padStart(6, "0")}`]);
    const done = seed.status === "COMPLETED" || seed.status === "REJECTED";
    const tripId = await one(
      database,
      `insert into trips (site_id, registration_id, trip_no, status, outcome, vehicle_id, driver_id, transporter_id, plate_no, exited_at, completed_at)
       select $1, $2, $3, $4, $5, $6, $7, $8, plate_no, $9::timestamptz, $9::timestamptz from vehicles where id = $6 returning id`,
      [
        site,
        registrationId,
        ["ISSUED", "DRAFT", "EXPIRED", "CANCELLED"].includes(seed.status) ? null : `TRIP-GPS-${counter}`,
        seed.status,
        seed.status === "COMPLETED" ? "OK" : seed.status === "REJECTED" ? "SPEC_REJECT" : null,
        seed.vehicleId,
        driverId,
        transporterId,
        seed.exitedAt ?? (done ? "2026-11-20T02:00:00Z" : null),
      ],
    );
    await database.query("insert into trip_allocations (trip_id, registration_allocation_id, seq) values ($1, $2, 1)", [tripId, allocationId]);
    const validUntil = seed.spjValidUntil === undefined ? "2026-11-27T03:00:00Z" : seed.spjValidUntil;
    if (validUntil !== null && seed.status !== "DRAFT") {
      await database.query(
        "insert into spj_documents (trip_id, spj_no, barcode_token, issued_by, issued_at, valid_until) values ($1, $2, $3, $4, '2026-11-19T03:00:00Z', $5::timestamptz)",
        [tripId, `SPJ-GPS-${counter}`, `GPS${String(counter).padStart(9, "0")}`, ids.logistik, validUntil],
      );
    }
    return tripId;
  };

  /** A source made through the master route; answers its id and the key shown once. */
  const source = async (name = "Penyedia Contoh", kind: "PROVIDER" | "DEVICE" = "PROVIDER") => {
    const response = await call("POST", "/api/gps/sources", "lacak", { name, kind });
    if (response.statusCode !== 201) throw new Error(response.body);
    const body = response.json() as { source: { id: number }; key: string };
    return { id: body.source.id, key: body.key };
  };
  const attach = async (vehicleId: number, sourceId: number, deviceId: string) => {
    const response = await call("POST", "/api/gps/trackers", "lacak", { vehicleId, sourceId, deviceId });
    if (response.statusCode !== 201) throw new Error(response.body);
    return (response.json() as { tracker: { id: number } }).tracker.id;
  };
  /** Sends device points with the key. */
  const send = (key: string, points: unknown[]) =>
    app.inject({ method: "POST", url: "/api/gps/positions", headers: { "x-tracker-key": key }, payload: { points } });
  /** ISO time `seconds` after the test clock's now. */
  const at = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000).toISOString();

  return { ...context, companies, ids, call, vehicle, trip, source, attach, send, at };
}
