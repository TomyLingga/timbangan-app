// Lookups for the registration form. A partner account may use them, so none of them lists drivers, vehicles
// or partners: a driver or a vehicle is found only by its whole licence number or plate, and a transporter only
// by part of its name, with the name and id as the only fields.
import { and, asc, count, eq, ilike, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { drivers, partners, vehicles, vehicleTypes } from "../db/schema.js";
import { lettersAndDigits, likeText, limitParam, searchParam, todayAtPlant } from "../http.js";
import { isDriverBlocked } from "../registrations/checks.js";

/** Shorter than this after normalisation, a licence number or a plate finds nothing. */
const MIN_KEY_LENGTH = 3;
/** Shorter than this, a transporter search finds nothing. */
const MIN_SEARCH_LENGTH = 2;

const keyParam = (label: string) => z.string(`${label} harus berupa teks.`).max(100, `${label} terlalu panjang.`).optional();
const driverQuery = z.object({ licenceNo: keyParam("Nomor SIM") });
const vehicleQuery = z.object({ plate: keyParam("Plat nomor") });
const transporterQuery = z.object({ q: searchParam, limit: limitParam });

/** The stored form of what was typed, or null when it is too short to look up. */
function lookupKey(typed: string | undefined): string | null {
  const key = lettersAndDigits(typed ?? "");
  return key.length >= MIN_KEY_LENGTH ? key : null;
}

export function registerLookupRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const formFillers = { preHandler: [guards.authenticate, guards.requirePermission("registrations", "CREATE")] };

  app.get("/api/lookup/driver", formFillers, async (request) => {
    const licenceNo = lookupKey(driverQuery.parse(request.query).licenceNo);
    if (licenceNo === null) return { driver: null };
    const [row] = await orm
      .select({
        id: drivers.id,
        fullName: drivers.fullName,
        licenceNo: drivers.licenceNo,
        licenceClass: drivers.licenceClass,
        licenceValidUntil: drivers.licenceValidUntil,
        registryStatus: drivers.registryStatus,
        isActive: drivers.isActive,
      })
      .from(drivers)
      .where(eq(drivers.licenceNo, licenceNo))
      .limit(1);
    if (!row) return { driver: null };
    const now = context.now();
    const { isActive, ...driver } = row;
    return {
      driver: {
        ...driver,
        licenceExpired: driver.licenceValidUntil !== null && driver.licenceValidUntil < todayAtPlant(now),
        blocked: await isDriverBlocked(orm, driver.id, now),
        isActive,
      },
    };
  });

  app.get("/api/lookup/vehicle", formFillers, async (request) => {
    const plateNo = lookupKey(vehicleQuery.parse(request.query).plate);
    if (plateNo === null) return { vehicle: null };
    const [row] = await orm
      .select({
        id: vehicles.id,
        plateNo: vehicles.plateNo,
        plateDisplay: vehicles.plateDisplay,
        vehicleTypeCode: vehicles.vehicleTypeCode,
        needsContainerNo: vehicleTypes.needsContainerNo,
        capacityKg: vehicles.capacityKg,
        tareKg: vehicles.tareKg,
        stnkValidUntil: vehicles.stnkValidUntil,
        taxValidUntil: vehicles.taxValidUntil,
        kirValidUntil: vehicles.kirValidUntil,
        verifiedAt: vehicles.verifiedAt,
        ownerId: partners.id,
        ownerName: partners.name,
        isActive: vehicles.isActive,
      })
      .from(vehicles)
      .leftJoin(vehicleTypes, eq(vehicleTypes.code, vehicles.vehicleTypeCode))
      .leftJoin(partners, eq(partners.id, vehicles.ownerPartnerId))
      .where(eq(vehicles.plateNo, plateNo))
      .limit(1);
    if (!row) return { vehicle: null };
    const today = todayAtPlant(context.now());
    const past = (date: string | null) => date !== null && date < today;
    return {
      vehicle: {
        id: row.id,
        plateNo: row.plateNo,
        plateDisplay: row.plateDisplay,
        vehicleTypeCode: row.vehicleTypeCode,
        needsContainerNo: row.needsContainerNo ?? false,
        capacityKg: row.capacityKg,
        tareKg: row.tareKg,
        // which of the three papers are past today, as GET /api/vehicles says it
        expired: [past(row.stnkValidUntil) && "STNK", past(row.taxValidUntil) && "TAX", past(row.kirValidUntil) && "KIR"].filter((paper) => paper !== false),
        verified: row.verifiedAt !== null,
        owner: row.ownerId !== null && row.ownerName !== null ? { id: row.ownerId, name: row.ownerName } : null,
        isActive: row.isActive,
      },
    };
  });

  app.get("/api/lookup/transporters", formFillers, async (request) => {
    const query = transporterQuery.parse(request.query);
    if (!query.q || query.q.length < MIN_SEARCH_LENGTH) return { items: [], total: 0 };
    const where = and(eq(partners.isActive, true), eq(partners.isTransporter, true), ilike(partners.name, likeText(query.q)));
    const [counted] = await orm.select({ total: count() }).from(partners).where(where);
    const items = await orm
      .select({ id: partners.id, name: partners.name })
      .from(partners)
      .where(where)
      .orderBy(asc(sql`lower(${partners.name})`), asc(partners.id))
      .limit(query.limit);
    return { items, total: counted?.total ?? 0 };
  });
}
