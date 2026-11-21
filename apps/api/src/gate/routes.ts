// The registration desk at the gate: scan the SPJ, check the truck in with a card, replace a card.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { cardAssignments, drivers, flowSteps, registrations, rfidCards, spjDocuments, trips, tripSteps, vehicles } from "../db/schema.js";
import { AppError, invalidState, refused } from "../errors.js";
import { idNumber, todayAtPlant } from "../http.js";
import { nextDocumentNo } from "../numbering.js";
import { driverPolicy, isDriverBlocked, registryVerdict, vehicleFindings } from "../registrations/checks.js";
import { normaliseUid } from "../rfid-cards/routes.js";
import { siteById } from "../settings.js";
import { DESK_ROLES, releaseCard } from "../trips/routes.js";
import { normaliseToken } from "../trips/spj.js";
import { ARRIVED_STATUSES, expireDueTrips, INSIDE_STATUSES, loadTrips } from "../trips/view.js";

const uidField = z
  .string("UID kartu wajib diisi.")
  .transform(normaliseUid)
  .pipe(z.string().regex(/^[0-9A-F]{8,20}$/, "UID kartu harus 8 sampai 20 digit heksadesimal."));
const checkInBody = z.object({ token: z.string("Token SPJ wajib diisi.").trim().min(1, "Token SPJ wajib diisi.").max(40, "Token SPJ terlalu panjang."), cardUid: uidField });
const replaceBody = z.object({
  tripId: idNumber,
  cardUid: uidField,
  reason: z.enum(["REPLACED", "LOST"], "Alasan harus REPLACED atau LOST."),
});

const spjNotFound = () => new AppError(404, "SPJ_NOT_FOUND", "SPJ dengan kode ini tidak ditemukan.");

/** The refusal code for a unique index that stopped a check-in racing another one; null for other errors. */
export function uniqueViolation(error: unknown): string | null {
  const codes: Record<string, string> = {
    trips_vehicle_inside_key: "VEHICLE_INSIDE",
    trips_driver_inside_key: "DRIVER_INSIDE",
    card_assignments_card_key: "CARD_IN_USE",
    card_assignments_trip_key: "ALREADY_CHECKED_IN",
  };
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const fields = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (fields.code === "23505") {
      const name = typeof fields.constraint === "string" ? fields.constraint : typeof fields.constraint_name === "string" ? fields.constraint_name : "";
      return codes[name] ?? null;
    }
    current = fields.cause;
  }
  return null;
}

const MESSAGES: Record<string, string> = {
  SPJ_EXPIRED: "SPJ sudah lewat masa berlaku. Minta terbit ulang.",
  SPJ_REVOKED: "SPJ ini sudah dicabut. Pakai SPJ yang terbaru.",
  ALREADY_CHECKED_IN: "Truk ini sudah check-in.",
  CARD_UNKNOWN: "Kartu belum terdaftar.",
  CARD_IN_USE: "Kartu sedang dipakai truk lain.",
  CARD_NOT_AVAILABLE: "Kartu berstatus hilang atau tidak dipakai lagi.",
  VEHICLE_INSIDE: "Kendaraan ini masih tercatat di dalam pabrik.",
  DRIVER_INSIDE: "Supir ini masih tercatat di dalam pabrik.",
};
const refuse = (code: string) => refused(code, MESSAGES[code] ?? code);

type Check = { code: string; level: "BLOCK" | "WARN"; message: string };

/** Another trip of the same vehicle or driver inside the plant. */
async function insideElsewhere(orm: Orm, trip: { id: number; vehicleId: number | null; driverId: number | null }) {
  const others = async (column: typeof trips.vehicleId | typeof trips.driverId, value: number | null) =>
    value === null ? false : (await orm.select({ id: trips.id }).from(trips).where(and(eq(column, value), inArray(trips.status, INSIDE_STATUSES), ne(trips.id, trip.id))).limit(1)).length > 0;
  return { vehicle: await others(trips.vehicleId, trip.vehicleId), driver: await others(trips.driverId, trip.driverId) };
}

/** Finds the card for a check-in, locked; refuses one that is unknown, in use, lost or retired. */
async function availableCard(orm: Orm, uid: string) {
  const [card] = await orm.select().from(rfidCards).where(eq(rfidCards.uid, uid)).for("update");
  if (!card) throw refuse("CARD_UNKNOWN");
  if (card.status === "IN_USE") throw refuse("CARD_IN_USE");
  if (card.status !== "AVAILABLE") throw refuse("CARD_NOT_AVAILABLE");
  return card;
}

export function registerGateRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const desk = { preHandler: [guards.authenticate, guards.requireRole(...DESK_ROLES)] };

  const tripView = async (db: Orm, id: number) => {
    const [trip] = await loadTrips(db, [id]);
    if (!trip) throw new Error(`Trip ${id} does not exist.`);
    return trip;
  };

  app.get("/api/gate/spj/:token", desk, async (request) => {
    const token = normaliseToken(String((request.params as { token?: unknown }).token ?? ""));
    const now = context.now();
    await expireDueTrips(orm, now);
    const [spj] = await orm.select().from(spjDocuments).where(eq(spjDocuments.barcodeToken, token));
    if (!spj) throw spjNotFound();
    const [row] = await orm
      .select({ trip: trips, driver: drivers, vehicle: vehicles })
      .from(trips)
      .leftJoin(drivers, eq(drivers.id, trips.driverId))
      .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
      .where(eq(trips.id, spj.tripId));
    if (!row) throw spjNotFound();
    const { trip, driver, vehicle } = row;
    const checks: Check[] = [];
    const block = (code: string) => checks.push({ code, level: "BLOCK", message: MESSAGES[code] ?? code });
    if (spj.revokedAt !== null) block("SPJ_REVOKED");
    else if (trip.status === "EXPIRED" || (spj.validUntil !== null && spj.validUntil < now)) block("SPJ_EXPIRED");
    if (ARRIVED_STATUSES.includes(trip.status)) block("ALREADY_CHECKED_IN");
    else if (spj.revokedAt === null && trip.status === "ISSUED") {
      if (driver) {
        const verdict = registryVerdict(await driverPolicy(orm, trip.siteId), driver.registryStatus, driver.fullName);
        if (verdict) checks.push(verdict);
        if (await isDriverBlocked(orm, driver.id, now)) checks.push({ code: "DRIVER_BLOCKED", level: "BLOCK", message: `Supir ${driver.fullName} sedang diblokir.` });
        if (driver.licenceValidUntil !== null && driver.licenceValidUntil < todayAtPlant(now)) {
          checks.push({ code: "LICENCE_EXPIRED", level: "WARN", message: `SIM ${driver.fullName} habis berlaku ${driver.licenceValidUntil}.` });
        }
      }
      if (vehicle) for (const found of vehicleFindings(vehicle, todayAtPlant(now))) checks.push({ ...found, level: "WARN" });
      const inside = await insideElsewhere(orm, trip);
      if (inside.vehicle) block("VEHICLE_INSIDE");
      if (inside.driver) block("DRIVER_INSIDE");
    }
    return { trip: await tripView(orm, trip.id), checks };
  });

  app.post("/api/gate/check-in", desk, async (request) => {
    const body = checkInBody.parse(request.body);
    const token = normaliseToken(body.token);
    const account = accountOf(request);
    const now = context.now();
    await expireDueTrips(orm, now);
    try {
      const trip = await orm.transaction(async (tx) => {
        const [spj] = await tx.select().from(spjDocuments).where(eq(spjDocuments.barcodeToken, token));
        if (!spj) throw spjNotFound();
        const [current] = await tx.select().from(trips).where(eq(trips.id, spj.tripId)).for("update");
        if (!current) throw spjNotFound();
        if (spj.revokedAt !== null) throw refuse("SPJ_REVOKED");
        if (ARRIVED_STATUSES.includes(current.status)) throw refuse("ALREADY_CHECKED_IN");
        if (current.status === "EXPIRED" || (spj.validUntil !== null && spj.validUntil < now)) throw refuse("SPJ_EXPIRED");
        if (current.status !== "ISSUED") throw invalidState("Truk ini belum siap check-in.");

        const [driver] = current.driverId === null ? [] : await tx.select().from(drivers).where(eq(drivers.id, current.driverId));
        if (driver) {
          const verdict = registryVerdict(await driverPolicy(tx, current.siteId), driver.registryStatus, driver.fullName);
          if (verdict?.level === "BLOCK") throw refused(verdict.code, verdict.message);
          if (await isDriverBlocked(tx, driver.id, now)) throw refused("DRIVER_BLOCKED", `Supir ${driver.fullName} sedang diblokir.`);
        }
        const card = await availableCard(tx, body.cardUid);
        const inside = await insideElsewhere(tx, current);
        if (inside.vehicle) throw refuse("VEHICLE_INSIDE");
        if (inside.driver) throw refuse("DRIVER_INSIDE");

        const site = await siteById(tx, current.siteId);
        const steps = await tx
          .select()
          .from(flowSteps)
          .where(and(eq(flowSteps.siteId, current.siteId), eq(flowSteps.flowCode, await flowOf(tx, current.registrationId))))
          .orderBy(asc(flowSteps.seq));
        const nextStep = steps.find((step) => step.stepCode !== "CHECK_IN" && !step.isOptional && step.seq > (steps.find((item) => item.stepCode === "CHECK_IN")?.seq ?? 0));
        await tx
          .update(trips)
          .set({ status: "CHECKED_IN", checkedInAt: now, tripNo: await nextDocumentNo(tx, "TRIP", site.code, now), currentStep: nextStep?.stepCode ?? null, updatedAt: now })
          .where(eq(trips.id, current.id));
        await tx.insert(cardAssignments).values({ cardId: card.id, tripId: current.id, assignedBy: account.id, assignedAt: now });
        await tx.update(rfidCards).set({ status: "IN_USE" }).where(eq(rfidCards.id, card.id));
        if (steps.length) {
          await tx.insert(tripSteps).values(
            steps.map((step) => {
              const done = step.stepCode === "CHECK_IN";
              const ready = step.stepCode === nextStep?.stepCode;
              return {
                tripId: current.id,
                stepCode: step.stepCode,
                seq: step.seq,
                status: done ? ("DONE" as const) : ready ? ("READY" as const) : ("PENDING" as const),
                result: done ? ("PASS" as const) : null,
                performedBy: done ? account.id : null,
                readyAt: done || ready ? now : null,
                startedAt: done ? now : null,
                finishedAt: done ? now : null,
              };
            }),
          );
        }
        await writeAudit(tx, request, now, { action: "TRIP_CHECKED_IN", entityType: "trip", entityId: current.id, before: { status: current.status }, after: { status: "CHECKED_IN", cardUid: card.uid } });
        return tripView(tx, current.id);
      });
      return { trip };
    } catch (error) {
      // two check-ins at the same moment: the unique indexes stop the second one
      const code = uniqueViolation(error);
      if (code) throw refuse(code);
      throw error;
    }
  });

  app.post("/api/gate/replace-card", desk, async (request) => {
    const body = replaceBody.parse(request.body);
    const account = accountOf(request);
    const now = context.now();
    try {
      const trip = await orm.transaction(async (tx) => {
        const [current] = await tx.select().from(trips).where(eq(trips.id, body.tripId)).for("update");
        if (!current) throw new AppError(404, "NOT_FOUND", "Trip tidak ditemukan.");
        const [assigned] = await tx.select().from(cardAssignments).where(and(eq(cardAssignments.tripId, current.id), isNull(cardAssignments.releasedAt)));
        if (!INSIDE_STATUSES.includes(current.status) || !assigned) throw invalidState("Kartu hanya bisa diganti untuk truk yang sedang di dalam dengan kartu terikat.");
        const card = await availableCard(tx, body.cardUid);
        // a damaged card is taken out of use; a lost one is marked lost
        await releaseCard(tx, current.id, account.id, now, body.reason, body.reason === "LOST" ? "LOST" : "RETIRED");
        await tx.insert(cardAssignments).values({ cardId: card.id, tripId: current.id, assignedBy: account.id, assignedAt: now });
        await tx.update(rfidCards).set({ status: "IN_USE" }).where(eq(rfidCards.id, card.id));
        await writeAudit(tx, request, now, { action: "CARD_REPLACED", entityType: "trip", entityId: current.id, before: { cardId: assigned.cardId }, after: { cardId: card.id }, reason: body.reason });
        return tripView(tx, current.id);
      });
      return { trip };
    } catch (error) {
      const code = uniqueViolation(error);
      if (code) throw refuse(code);
      throw error;
    }
  });
}

async function flowOf(orm: Orm, registrationId: number): Promise<string> {
  const [row] = await orm.select({ flowCode: registrations.flowCode }).from(registrations).where(eq(registrations.id, registrationId));
  if (!row) throw new Error(`Registration ${registrationId} does not exist.`);
  return row.flowCode;
}
