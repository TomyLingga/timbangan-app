// Master of the RFID cards handed to trucks at the registration desk.
import { and, asc, count, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { cardAssignments, rfidCards, trips } from "../db/schema.js";
import { duplicate, invalidState, notFound } from "../errors.js";
import { idParams, likeText, limitParam, searchParam } from "../http.js";
import { defaultSite } from "../settings.js";

const UID_PATTERN = /^[0-9A-F]{8,20}$/;
/** Upper-case hexadecimal without separators: what a reader types, cleaned. */
export const normaliseUid = (text: string) => text.toUpperCase().replace(/[\s:.-]/g, "");

const uidField = z
  .string("UID kartu wajib diisi.")
  .transform(normaliseUid)
  .pipe(z.string().regex(UID_PATTERN, "UID kartu harus 8 sampai 20 digit heksadesimal."));
const text = (label: string, max: number) => z.string(`${label} harus berupa teks.`).trim().max(max, `${label} terlalu panjang.`).nullable().optional();

const listQuery = z.object({
  q: searchParam,
  status: z.enum(["AVAILABLE", "IN_USE", "LOST", "RETIRED"], "Status harus AVAILABLE, IN_USE, LOST, atau RETIRED.").optional(),
  limit: limitParam,
});
const createBody = z.object({ uid: uidField, label: text("Label", 50), note: text("Catatan", 500) });
const patchBody = z.object({
  label: text("Label", 50),
  note: text("Catatan", 500),
  status: z.enum(["AVAILABLE", "LOST", "RETIRED"], "Status hanya boleh AVAILABLE, LOST, atau RETIRED.").optional(),
});

async function listCards(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm
    .select({
      id: rfidCards.id,
      uid: rfidCards.uid,
      label: rfidCards.label,
      status: rfidCards.status,
      note: rfidCards.note,
      tripId: trips.id,
      tripNo: trips.tripNo,
      plateNo: trips.plateNo,
    })
    .from(rfidCards)
    .leftJoin(cardAssignments, and(eq(cardAssignments.cardId, rfidCards.id), isNull(cardAssignments.releasedAt)))
    .leftJoin(trips, eq(trips.id, cardAssignments.tripId))
    .where(where)
    .orderBy(asc(rfidCards.uid))
    .limit(limit);
  return rows.map(({ tripId, tripNo, plateNo, ...card }) => ({ ...card, trip: tripId === null ? null : { id: tripId, tripNo, plateNo } }));
}

export function registerRfidCardRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const admins = { preHandler: [guards.authenticate, guards.requireRole("SUPER_ADMIN", "LOGISTICS_ADMIN")] };
  const one = async (db: Orm, id: number) => {
    const [card] = await listCards(db, eq(rfidCards.id, id), 1);
    if (!card) throw notFound("Kartu");
    return card;
  };

  app.get("/api/rfid-cards", admins, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      query.status ? eq(rfidCards.status, query.status) : undefined,
      pattern ? or(ilike(rfidCards.uid, likeText(normaliseUid(query.q ?? ""))), ilike(rfidCards.label, pattern)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(rfidCards).where(where);
    return { items: await listCards(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.post("/api/rfid-cards", admins, async (request, reply) => {
    const body = createBody.parse(request.body);
    const card = await orm.transaction(async (tx) => {
      const [taken] = await tx.select({ id: rfidCards.id }).from(rfidCards).where(eq(rfidCards.uid, body.uid));
      if (taken) throw duplicate(`Kartu ${body.uid} sudah terdaftar.`);
      const site = await defaultSite(tx);
      const [created] = await tx.insert(rfidCards).values({ ...body, siteId: site.id }).returning({ id: rfidCards.id });
      if (!created) throw new Error("The card was not created.");
      return one(tx, created.id);
    });
    return reply.code(201).send({ card });
  });

  app.patch("/api/rfid-cards/:id", admins, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const card = await orm.transaction(async (tx) => {
      const [current] = await tx.select({ status: rfidCards.status }).from(rfidCards).where(eq(rfidCards.id, id)).for("update");
      if (!current) throw notFound("Kartu");
      if (body.status !== undefined && body.status !== current.status) {
        const [bound] = await tx.select({ id: cardAssignments.id }).from(cardAssignments).where(and(eq(cardAssignments.cardId, id), isNull(cardAssignments.releasedAt)));
        if (bound || current.status === "IN_USE") throw invalidState("Kartu sedang dipakai truk. Lepas kartu dulu sebelum mengubah statusnya.");
      }
      if (Object.values(body).some((value) => value !== undefined)) await tx.update(rfidCards).set(body).where(eq(rfidCards.id, id));
      return one(tx, id);
    });
    return { card };
  });
}
