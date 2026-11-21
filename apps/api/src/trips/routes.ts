// Trips for the registration desk, the SPJ print data, reissue and cancel.
import { and, asc, count, eq, ilike, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import {
  cardAssignments,
  deliveryOrders,
  destinations,
  drivers,
  erpContracts,
  partners,
  products,
  registrationAllocations,
  registrations,
  rfidCards,
  sites,
  spjDocuments,
  tripAllocations,
  trips,
  TRIP_STATUSES,
  tripSteps,
  vehicles,
  vehicleTypes,
} from "../db/schema.js";
import { forbidden, invalidState, notFound } from "../errors.js";
import { dateText, idParams, lettersAndDigits, likeText, limitParam, PLANT_TIME_ZONE, searchParam } from "../http.js";
import { registrationsVisibleTo } from "../registrations/view.js";
import { issueSpj, revokeSpj } from "./spj.js";
import { expireDueTrips, loadTrips } from "./view.js";

/** Staff who reissue SPJs and work the registration desk. */
export const DESK_ROLES = ["SUPER_ADMIN", "LOGISTICS_ADMIN", "REGISTRATION_OPERATOR"];

const STATUS_MESSAGE = `Status trip harus salah satu dari ${TRIP_STATUSES.join(", ")}; beberapa dipisah koma.`;
const listQuery = z.object({
  status: z
    .string(STATUS_MESSAGE)
    .transform((text) => text.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(z.enum(TRIP_STATUSES, STATUS_MESSAGE)))
    .optional(),
  date: dateText("Tanggal").optional(),
  q: searchParam,
  limit: limitParam,
});
const reasonBody = z.object({ reason: z.string("Alasan wajib diisi.").trim().min(1, "Alasan wajib diisi.").max(500, "Alasan terlalu panjang.") });

const linePartner = alias(partners, "line_partner");
const transporterOf = alias(partners, "spj_transporter");

/** The trip row locked for a change; 404 when the account may not see its registration. */
export async function lockTrip(orm: Orm, id: number, account: Account) {
  const [row] = await orm
    .select({ trip: trips })
    .from(trips)
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .where(and(eq(trips.id, id), registrationsVisibleTo(account)))
    .for("update", { of: trips });
  if (!row) throw notFound("Trip");
  return row.trip;
}

/** Releases the card the trip carries; the card goes back to the given status. */
export async function releaseCard(
  orm: Orm,
  tripId: number,
  actor: number,
  now: Date,
  reason: "CHECK_OUT" | "REPLACED" | "CANCELLED" | "LOST",
  cardStatus: "AVAILABLE" | "LOST" | "RETIRED",
): Promise<void> {
  const released = await orm
    .update(cardAssignments)
    .set({ releasedAt: now, releasedBy: actor, releaseReason: reason })
    .where(and(eq(cardAssignments.tripId, tripId), isNull(cardAssignments.releasedAt)))
    .returning({ cardId: cardAssignments.cardId });
  if (released.length) await orm.update(rfidCards).set({ status: cardStatus }).where(inArray(rfidCards.id, released.map((row) => row.cardId)));
}

export function registerTripRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const signedIn = { preHandler: [guards.authenticate, guards.requireRole()] };
  const staff = { preHandler: [guards.authenticate, guards.requireStaff] };
  const desk = { preHandler: [guards.authenticate, guards.requireRole(...DESK_ROLES)] };

  const view = async (db: Orm, id: number) => {
    const [trip] = await loadTrips(db, [id]);
    if (!trip) throw notFound("Trip");
    return trip;
  };

  app.get("/api/trips", staff, async (request) => {
    const query = listQuery.parse(request.query);
    await expireDueTrips(orm, context.now());
    const plate = query.q ? lettersAndDigits(query.q) : "";
    const pattern = query.q ? likeText(query.q) : null;
    const conditions: (SQL | undefined)[] = [query.status?.length ? inArray(trips.status, query.status) : undefined];
    if (query.date) {
      conditions.push(
        or(
          sql`coalesce(${trips.plannedArrival}, ${registrations.plannedDate}) = ${query.date}`,
          sql`(${trips.checkedInAt} at time zone ${PLANT_TIME_ZONE})::date = ${query.date}`,
        ),
      );
    }
    if (pattern) {
      conditions.push(
        or(
          plate ? ilike(trips.plateNo, likeText(plate)) : undefined,
          plate ? sql`exists (select 1 from vehicles v where v.id = ${trips.vehicleId} and v.plate_no like ${likeText(plate)})` : undefined,
          ilike(trips.tripNo, pattern),
          sql`exists (select 1 from spj_documents s where s.trip_id = ${trips.id} and s.spj_no ilike ${pattern})`,
        ),
      );
    }
    const where = and(...conditions);
    const [counted] = await orm.select({ total: count() }).from(trips).innerJoin(registrations, eq(registrations.id, trips.registrationId)).where(where);
    const ids = await orm
      .select({ id: trips.id })
      .from(trips)
      .innerJoin(registrations, eq(registrations.id, trips.registrationId))
      .where(where)
      .orderBy(sql`coalesce(${trips.plannedArrival}, ${registrations.plannedDate}) nulls last`, asc(trips.id))
      .limit(query.limit);
    return { items: await loadTrips(orm, ids.map((row) => row.id)), total: counted?.total ?? 0 };
  });

  /** The active SPJ of a trip the account may see. */
  const activeSpj = async (db: Orm, tripId: number, account: Account) => {
    const [row] = await db
      .select({ spj: spjDocuments })
      .from(spjDocuments)
      .innerJoin(trips, eq(trips.id, spjDocuments.tripId))
      .innerJoin(registrations, eq(registrations.id, trips.registrationId))
      .where(and(eq(spjDocuments.tripId, tripId), isNull(spjDocuments.revokedAt), registrationsVisibleTo(account)));
    if (!row) throw notFound("SPJ");
    return row.spj;
  };

  app.get("/api/trips/:id/spj", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const spj = await activeSpj(orm, id, accountOf(request));
    const [head] = await orm
      .select({
        siteCode: sites.code,
        siteName: sites.name,
        direction: registrations.direction,
        driverName: trips.driverName,
        licenceNo: trips.licenceNo,
        currentDriverName: drivers.fullName,
        currentLicenceNo: drivers.licenceNo,
        plateDisplay: vehicles.plateDisplay,
        vehicleType: vehicleTypes.name,
        containerNo: trips.containerNo,
        transporterId: transporterOf.id,
        transporterName: transporterOf.name,
      })
      .from(trips)
      .innerJoin(registrations, eq(registrations.id, trips.registrationId))
      .innerJoin(sites, eq(sites.id, trips.siteId))
      .leftJoin(drivers, eq(drivers.id, trips.driverId))
      .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
      .leftJoin(vehicleTypes, eq(vehicleTypes.code, vehicles.vehicleTypeCode))
      .leftJoin(transporterOf, eq(transporterOf.id, trips.transporterId))
      .where(eq(trips.id, id));
    if (!head) throw notFound("Trip");
    const lines = await orm
      .select({
        contractNo: registrationAllocations.contractNo,
        doNo: registrationAllocations.doNo,
        productId: products.id,
        productName: products.name,
        qtyPlanned: tripAllocations.qtyPlanned,
        doUom: deliveryOrders.uom,
        contractUom: erpContracts.uom,
        partnerId: linePartner.id,
        partnerName: linePartner.name,
        destination: { id: destinations.id, name: destinations.name, address: destinations.address, district: destinations.district, regency: destinations.regency, province: destinations.province },
      })
      .from(tripAllocations)
      .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
      .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
      .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
      .leftJoin(destinations, eq(destinations.id, deliveryOrders.destinationId))
      .innerJoin(products, or(eq(products.id, erpContracts.productId), eq(products.id, deliveryOrders.productId)))
      .innerJoin(linePartner, or(eq(linePartner.id, erpContracts.partnerId), eq(linePartner.id, deliveryOrders.partnerId)))
      .where(eq(tripAllocations.tripId, id))
      .orderBy(asc(tripAllocations.seq));
    return {
      spj: {
        spjNo: spj.spjNo,
        barcodeToken: spj.barcodeToken,
        issuedAt: spj.issuedAt,
        validUntil: spj.validUntil,
        printCount: spj.printCount,
        site: { code: head.siteCode, name: head.siteName },
        direction: head.direction,
        driver: { fullName: head.driverName ?? head.currentDriverName, licenceNo: head.licenceNo ?? head.currentLicenceNo },
        vehicle: { plateDisplay: head.plateDisplay, vehicleType: head.vehicleType },
        containerNo: head.containerNo,
        transporter: head.transporterId !== null && head.transporterName !== null ? { id: head.transporterId, name: head.transporterName } : null,
        lines: lines.map((line) => ({
          contractNo: line.contractNo,
          doNo: line.doNo,
          product: { id: line.productId, name: line.productName },
          qtyPlanned: line.qtyPlanned,
          uom: line.doUom ?? line.contractUom,
          partner: { id: line.partnerId, name: line.partnerName },
          destination: line.destination?.id ? line.destination : null,
        })),
      },
    };
  });

  app.post("/api/trips/:id/spj/printed", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const spj = await activeSpj(orm, id, accountOf(request));
    const [updated] = await orm
      .update(spjDocuments)
      .set({ printCount: sql`${spjDocuments.printCount} + 1` })
      .where(eq(spjDocuments.id, spj.id))
      .returning({ printCount: spjDocuments.printCount });
    return { printCount: updated?.printCount ?? spj.printCount + 1 };
  });

  app.post("/api/trips/:id/spj/reissue", desk, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = reasonBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    await expireDueTrips(orm, now);
    const trip = await orm.transaction(async (tx) => {
      const current = await lockTrip(tx, id, account);
      const [registration] = await tx.select({ status: registrations.status }).from(registrations).where(eq(registrations.id, current.registrationId));
      if (!["ISSUED", "EXPIRED"].includes(current.status) || registration?.status !== "APPROVED") {
        throw invalidState("SPJ hanya bisa diterbitkan ulang untuk truk yang belum check-in pada registrasi yang disetujui.");
      }
      await revokeSpj(tx, id, account.id, now, reason);
      await issueSpj(tx, id, account.id, now);
      await writeAudit(tx, request, now, { action: "SPJ_REISSUED", entityType: "trip", entityId: id, before: { status: current.status }, after: { status: "ISSUED" }, reason });
      return view(tx, id);
    });
    return { trip };
  });

  // the owner cancels before check-in; desk staff also after check-in, before the truck is weighed
  app.post("/api/trips/:id/cancel", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const isDesk = account.kind === "INTERNAL" && account.roles.some((role) => DESK_ROLES.includes(role));
    if (account.kind === "INTERNAL" && !isDesk) throw forbidden();
    const { reason } = reasonBody.parse(request.body ?? {});
    const now = context.now();
    const trip = await orm.transaction(async (tx) => {
      const current = await lockTrip(tx, id, account);
      const allowed = isDesk ? ["DRAFT", "READY", "ISSUED", "EXPIRED", "CHECKED_IN"] : ["DRAFT", "READY", "ISSUED", "EXPIRED"];
      if (!allowed.includes(current.status)) {
        throw invalidState(isDesk ? "Trip ini sudah ditimbang, selesai, atau dibatalkan." : "Trip yang sudah check-in hanya bisa dibatalkan petugas.");
      }
      await tx.update(trips).set({ status: "CANCELLED", cancelledAt: now, cancelReason: reason, currentStep: null, updatedAt: now }).where(eq(trips.id, id));
      await revokeSpj(tx, id, account.id, now, reason);
      await releaseCard(tx, id, account.id, now, "CANCELLED", "AVAILABLE");
      await tx.update(tripSteps).set({ status: "SKIPPED" }).where(and(eq(tripSteps.tripId, id), ne(tripSteps.status, "DONE")));
      await writeAudit(tx, request, now, { action: "TRIP_CANCELLED", entityType: "trip", entityId: id, before: { status: current.status }, after: { status: "CANCELLED" }, reason });
      return view(tx, id);
    });
    return { trip };
  });
}
