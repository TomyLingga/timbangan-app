// Places goods are delivered to. Kept here because the ERP partner has no district and regency.
import { and, asc, count, eq, ilike, isNull, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { destinations, partners } from "../db/schema.js";
import { invalid, notFound } from "../errors.js";
import { idNumber, idParams, likeText, limitParam, searchParam } from "../http.js";

const listQuery = z.object({ partnerId: idNumber.optional(), q: searchParam, limit: limitParam });

const place = (label: string) => z.string(`${label} harus berupa teks.`).trim().max(200, `${label} terlalu panjang.`).nullable().optional();
const fields = {
  // null: a place every customer can be sent to
  partnerId: idNumber.nullable().optional(),
  name: z.string("Nama tempat wajib diisi.").trim().min(1, "Nama tempat wajib diisi.").max(200, "Nama tempat terlalu panjang."),
  address: z.string("Alamat wajib diisi.").trim().min(1, "Alamat wajib diisi.").max(500, "Alamat terlalu panjang."),
  district: place("Kecamatan"),
  regency: place("Kabupaten/kota"),
  province: place("Provinsi"),
};
const createBody = z.object(fields);
const patchBody = z.object({ ...fields, name: fields.name.optional(), address: fields.address.optional(), isActive: z.boolean("isActive harus true atau false.").optional() });

async function listDestinations(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm
    .select({
      id: destinations.id, partnerId: partners.id, partnerName: partners.name, name: destinations.name, address: destinations.address,
      district: destinations.district, regency: destinations.regency, province: destinations.province, isActive: destinations.isActive,
    })
    .from(destinations)
    .leftJoin(partners, eq(partners.id, destinations.partnerId))
    .where(where)
    .orderBy(asc(sql`lower(${destinations.name})`), asc(destinations.id))
    .limit(limit);
  return rows.map(({ id, partnerId, partnerName, ...rest }) => ({ id, partner: partnerId !== null && partnerName !== null ? { id: partnerId, name: partnerName } : null, ...rest }));
}

export function registerDestinationRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const writers = { preHandler: [guards.authenticate, guards.requireRole("SUPER_ADMIN", "LOGISTICS_ADMIN")] };

  const one = async (db: Orm, id: number) => {
    const [destination] = await listDestinations(db, eq(destinations.id, id), 1);
    if (!destination) throw notFound("Tujuan");
    return destination;
  };
  const checkPartner = async (db: Orm, partnerId: number | null | undefined) => {
    if (partnerId === undefined || partnerId === null) return;
    const [partner] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId));
    if (!partner) throw invalid("partnerId", "Partner tidak ditemukan.");
  };

  app.get("/api/destinations", { preHandler: [guards.authenticate, guards.requireStaff] }, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      // the places of that partner, and the places usable for any partner
      query.partnerId === undefined ? undefined : or(eq(destinations.partnerId, query.partnerId), isNull(destinations.partnerId)),
      pattern ? or(ilike(destinations.name, pattern), ilike(destinations.address, pattern)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(destinations).where(where);
    return { items: await listDestinations(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.post("/api/destinations", writers, async (request, reply) => {
    const body = createBody.parse(request.body);
    const destination = await orm.transaction(async (tx) => {
      await checkPartner(tx, body.partnerId);
      const [created] = await tx.insert(destinations).values({ ...body, createdBy: accountOf(request).id, createdAt: context.now() }).returning({ id: destinations.id });
      if (!created) throw new Error("The destination was not created.");
      return one(tx, created.id);
    });
    return reply.code(201).send({ destination });
  });

  app.patch("/api/destinations/:id", writers, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const destination = await orm.transaction(async (tx) => {
      await one(tx, id);
      await checkPartner(tx, body.partnerId);
      if (Object.values(body).some((value) => value !== undefined)) await tx.update(destinations).set(body).where(eq(destinations.id, id));
      return one(tx, id);
    });
    return { destination };
  });
}
