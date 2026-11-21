// The work list of the phones: the waiting steps an account may do, one step with what its form needs,
// finding a truck by barcode, plate or card, and the seal stock the seal officer chooses from.
import { and, asc, eq, ilike, inArray, isNull, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { cardAssignments, flowSteps, rfidCards, SEAL_KINDS, seals, spjDocuments, trips, tripSteps } from "../db/schema.js";
import { invalid, notFound } from "../errors.js";
import { idParams, lettersAndDigits, likeText, limitParam, searchParam } from "../http.js";
import { normaliseUid } from "../rfid-cards/routes.js";
import { defaultSite } from "../settings.js";
import { normaliseToken } from "../trips/spj.js";
import { INSIDE_STATUSES } from "../trips/view.js";
import { loadFormData, loadWorkRows, viewableModules, WAITING } from "./view.js";

const listQuery = z.object({
  module: z.string("Modul harus berupa teks.").regex(/^[a-z_]{1,40}$/, "Modul tidak dikenal.").optional(),
  q: searchParam,
  limit: limitParam,
});
const findQuery = z.object({
  barcode: z.string().trim().max(40, "Barcode terlalu panjang.").optional(),
  plate: z.string().trim().max(20, "Plat terlalu panjang.").optional(),
  cardUid: z.string().trim().max(40, "UID kartu terlalu panjang.").optional(),
});
const sealQuery = z.object({
  kind: z.enum(SEAL_KINDS, `Jenis harus salah satu dari ${SEAL_KINDS.join(", ")}.`).optional(),
  q: searchParam,
  limit: limitParam,
});

/** Waiting steps of trucks inside the plant, of these modules. */
const waitingOf = (modules: string[]): SQL | undefined =>
  and(inArray(tripSteps.status, [...WAITING]), inArray(trips.status, INSIDE_STATUSES), modules.length ? inArray(flowSteps.performerModule, modules) : eq(flowSteps.performerModule, ""));

const truckGone = () => notFound("Truk di dalam pabrik");

/** The trip a barcode, plate or card points at, or null. */
async function findTrip(orm: Orm, query: z.infer<typeof findQuery>): Promise<number | null> {
  if (query.barcode) {
    const [spj] = await orm
      .select({ tripId: spjDocuments.tripId })
      .from(spjDocuments)
      .where(and(eq(spjDocuments.barcodeToken, normaliseToken(query.barcode)), isNull(spjDocuments.revokedAt)));
    return spj?.tripId ?? null;
  }
  if (query.plate) {
    const [trip] = await orm
      .select({ id: trips.id })
      .from(trips)
      .where(and(eq(trips.plateNo, lettersAndDigits(query.plate)), inArray(trips.status, INSIDE_STATUSES)))
      .limit(1);
    return trip?.id ?? null;
  }
  const [assigned] = await orm
    .select({ tripId: cardAssignments.tripId })
    .from(cardAssignments)
    .innerJoin(rfidCards, eq(rfidCards.id, cardAssignments.cardId))
    .where(and(eq(rfidCards.uid, normaliseUid(query.cardUid ?? "")), isNull(cardAssignments.releasedAt)));
  return assigned?.tripId ?? null;
}

export function registerWorkRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const staff = { preHandler: [guards.authenticate, guards.requireInternal] };

  app.get("/api/work/steps", staff, async (request) => {
    const query = listQuery.parse(request.query);
    const held = viewableModules(accountOf(request));
    const modules = query.module ? held.filter((code) => code === query.module) : held;
    const plate = query.q ? lettersAndDigits(query.q) : "";
    return { items: await loadWorkRows(orm, and(waitingOf(modules), plate ? ilike(trips.plateNo, likeText(plate)) : undefined), query.limit) };
  });

  app.get("/api/work/steps/:id", staff, async (request) => {
    const { id } = idParams.parse(request.params);
    const [row] = await loadWorkRows(orm, eq(tripSteps.id, id), 1);
    if (!row || !row.module || !viewableModules(accountOf(request)).includes(row.module)) throw notFound("Langkah");
    const [trip] = await orm.select({ siteId: trips.siteId }).from(trips).where(eq(trips.id, row.truck.tripId));
    return { step: row, form: await loadFormData(orm, row, trip?.siteId ?? 0, context.now()) };
  });

  app.get("/api/work/find", staff, async (request) => {
    const query = findQuery.parse(request.query);
    const given = [query.barcode, query.plate, query.cardUid].filter((value) => value !== undefined && value.length > 0);
    if (given.length !== 1) throw invalid("query", "Isi tepat satu: barcode, plate, atau cardUid.");
    const tripId = await findTrip(orm, query);
    if (tripId === null) throw truckGone();
    const [trip] = await orm.select({ status: trips.status }).from(trips).where(eq(trips.id, tripId));
    if (!trip || !INSIDE_STATUSES.includes(trip.status)) throw truckGone();
    const [any] = await loadWorkRows(orm, eq(trips.id, tripId), 1);
    if (!any) throw truckGone();
    const steps = await loadWorkRows(orm, and(eq(trips.id, tripId), waitingOf(viewableModules(accountOf(request)))), 20);
    return { truck: any.truck, steps: steps.map(({ truck: _truck, ...step }) => step) };
  });

  app.get("/api/work/seals/available", { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("sealing", "CREATE")] }, async (request) => {
    const query = sealQuery.parse(request.query);
    const site = await defaultSite(orm);
    const items = await orm
      .select({ id: seals.id, sealNo: seals.sealNo, kind: seals.kind })
      .from(seals)
      .where(
        and(
          eq(seals.siteId, site.id),
          eq(seals.status, "AVAILABLE"),
          query.kind ? eq(seals.kind, query.kind) : undefined,
          query.q ? ilike(seals.sealNo, likeText(query.q)) : undefined,
        ),
      )
      .orderBy(asc(seals.sealNo), asc(seals.id))
      .limit(query.limit);
    return { items };
  });
}
