// Plant masters (module plant_masters): the storage tanks a load or an unload goes to, and the stock of seal
// numbers the seal officer takes from. Tanks copied from Odoo (erp_ref set) are read only here, except isActive.
import { and, asc, count, eq, ilike, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { products, SEAL_KINDS, SEAL_STATUSES, seals, storageTanks, trips, tripSeals } from "../db/schema.js";
import { tankIsLabelled } from "./tank-products.js";
import { duplicate, invalid, invalidState, notFound, refused, violatedUnique } from "../errors.js";
import { idNumber, idParams, likeText, limitParam, searchParam } from "../http.js";
import { defaultSite } from "../settings.js";

/** The most seal numbers one batch request adds. */
export const MAX_SEAL_BATCH = 5_000;

const tankCode = z
  .string("Kode tangki wajib diisi.")
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, "Kode tangki 1 sampai 20 huruf, angka, atau tanda minus.");
const tankFields = {
  code: tankCode,
  name: z
    .string("Nama tangki harus berupa teks.")
    .trim()
    .max(100, "Nama tangki terlalu panjang.")
    .transform((text) => (text.length > 0 ? text : null))
    .nullable()
    .optional(),
  productId: z.number("Produk harus berupa id.").int("Produk harus berupa id.").positive("Produk harus berupa id.").nullable().optional(),
  capacityKg: z.number("Kapasitas harus angka.").int("Kapasitas harus kilogram bulat.").positive("Kapasitas harus lebih dari 0.").max(1e12, "Kapasitas terlalu besar.").nullable().optional(),
  isActive: z.boolean("Aktif harus true atau false.").optional(),
};
const tankCreate = z.object(tankFields);
const tankPatch = z.object(tankFields).partial();
const tankQuery = z.object({
  q: searchParam,
  productId: idNumber.optional(),
  active: z.enum(["true", "false"], "active harus true atau false.").optional(),
});

const sealQuery = z.object({
  status: z.enum(SEAL_STATUSES, `Status harus salah satu dari ${SEAL_STATUSES.join(", ")}.`).optional(),
  kind: z.enum(SEAL_KINDS, `Jenis harus salah satu dari ${SEAL_KINDS.join(", ")}.`).optional(),
  q: searchParam,
  limit: limitParam,
  offset: z.coerce.number("Offset harus angka mulai dari 0.").int("Offset harus angka mulai dari 0.").min(0, "Offset harus angka mulai dari 0.").default(0),
});
const counter = (label: string) => z.number(`${label} harus angka.`).int(`${label} harus bilangan bulat.`).min(0, `${label} tidak boleh negatif.`).max(999_999_999_999, `${label} terlalu besar.`);
const sealBatch = z
  .object({
    kind: z.enum(SEAL_KINDS, `Jenis segel harus ${SEAL_KINDS.join(" atau ")}.`),
    prefix: z
      .string("Awalan harus berupa teks.")
      .trim()
      .toUpperCase()
      .max(20, "Awalan terlalu panjang.")
      .regex(/^[A-Z0-9/-]*$/, "Awalan hanya boleh huruf, angka, garis miring, dan tanda minus.")
      .default(""),
    from: counter("Nomor awal"),
    to: counter("Nomor akhir"),
    width: z.number("Lebar angka harus angka.").int("Lebar angka harus bilangan bulat.").min(1, "Lebar angka 1 sampai 12.").max(12, "Lebar angka 1 sampai 12."),
  })
  .superRefine((body, issues) => {
    if (body.to < body.from) issues.addIssue({ code: "custom", path: ["to"], message: "Nomor akhir tidak boleh lebih kecil dari nomor awal." });
    else if (body.to - body.from + 1 > MAX_SEAL_BATCH) issues.addIssue({ code: "custom", path: ["to"], message: "Paling banyak 5.000 segel sekali tambah." });
    if (String(body.to).length > body.width) issues.addIssue({ code: "custom", path: ["width"], message: `Lebar angka kurang untuk nomor ${body.to}.` });
  });
const sealPatch = z.object({ status: z.literal("VOID", "Status segel hanya bisa diubah menjadi VOID.") });

type TankRow = typeof storageTanks.$inferSelect;

/** Tanks with their product, in code order. */
async function loadTanks(orm: Orm, where: SQL | undefined) {
  const rows = await orm
    .select({ tank: storageTanks, productName: products.name })
    .from(storageTanks)
    .leftJoin(products, eq(products.id, storageTanks.productId))
    .where(where)
    .orderBy(asc(storageTanks.code), asc(storageTanks.id));
  return rows.map(({ tank, productName }) => tankView(tank, productName));
}

export const tankView = (tank: TankRow, productName: string | null) => ({
  id: tank.id,
  code: tank.code,
  name: tank.name,
  product: tank.productId === null ? null : { id: tank.productId, name: productName },
  /** The product name Odoo keeps on the tank location, shown when no synced product matched it. */
  productLabel: tank.productLabel,
  capacityKg: tank.capacityKg,
  isActive: tank.isActive,
  /** False for a tank without product and label: the field forms never offer it (tankUse). */
  usableInForms: tankIsLabelled(tank),
  /** ODOO: copied by the Odoo sync and read only here except isActive; LOCAL: kept in this application. */
  source: tank.erpRef === null ? ("LOCAL" as const) : ("ODOO" as const),
});

/** Seals with the trip that carries each one, if any. */
async function loadSeals(orm: Orm, where: SQL | undefined, limit: number, offset: number) {
  const rows = await orm
    .select({ seal: seals, tripId: trips.id, tripNo: trips.tripNo, plateNo: trips.plateNo })
    .from(seals)
    .leftJoin(tripSeals, eq(tripSeals.sealId, seals.id))
    .leftJoin(trips, eq(trips.id, tripSeals.tripId))
    .where(where)
    .orderBy(asc(seals.sealNo), asc(seals.kind), asc(seals.id))
    .limit(limit)
    .offset(offset);
  return rows.map(({ seal, tripId, tripNo, plateNo }) => ({
    id: seal.id,
    sealNo: seal.sealNo,
    kind: seal.kind,
    status: seal.status,
    batchRef: seal.batchRef,
    createdAt: seal.createdAt,
    trip: tripId === null ? null : { id: tripId, tripNo, plateNo },
  }));
}

export function registerPlantMasterRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const level = (needed: "VIEW" | "CREATE" | "EDIT") => ({
    preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("plant_masters", needed)],
  });

  const checkProduct = async (db: Orm, productId: number | null | undefined) => {
    if (productId === null || productId === undefined) return;
    const [found] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
    if (!found) throw invalid("productId", "Produk tidak ditemukan.");
  };
  const codeTaken = (code: string) => duplicate(`Kode tangki ${code} sudah dipakai.`);
  const fromErp = () => refused("FROM_ERP", "Tangki ini dari Odoo. Ubah datanya di Odoo; di sini hanya bisa diaktifkan atau dinonaktifkan.");
  const oneTank = async (db: Orm, id: number) => {
    const [view] = await loadTanks(db, eq(storageTanks.id, id));
    if (!view) throw notFound("Tangki");
    return view;
  };

  app.get("/api/tanks", level("VIEW"), async (request) => {
    const query = tankQuery.parse(request.query);
    const site = await defaultSite(orm);
    const items = await loadTanks(
      orm,
      and(
        eq(storageTanks.siteId, site.id),
        query.q
          ? or(ilike(storageTanks.code, likeText(query.q)), ilike(storageTanks.name, likeText(query.q)), ilike(storageTanks.productLabel, likeText(query.q)))
          : undefined,
        query.productId === undefined ? undefined : eq(storageTanks.productId, query.productId),
        query.active === undefined ? undefined : eq(storageTanks.isActive, query.active === "true"),
      ),
    );
    return { items };
  });

  app.post("/api/tanks", level("CREATE"), async (request, reply) => {
    const body = tankCreate.parse(request.body ?? {});
    const now = context.now();
    try {
      const tank = await orm.transaction(async (tx) => {
        const site = await defaultSite(tx);
        await checkProduct(tx, body.productId);
        const [taken] = await tx.select({ id: storageTanks.id }).from(storageTanks).where(and(eq(storageTanks.siteId, site.id), eq(storageTanks.code, body.code)));
        if (taken) throw codeTaken(body.code);
        const [row] = await tx
          .insert(storageTanks)
          .values({ siteId: site.id, code: body.code, name: body.name ?? null, productId: body.productId ?? null, capacityKg: body.capacityKg ?? null, isActive: body.isActive ?? true })
          .returning();
        if (!row) throw new Error("The tank was not saved.");
        const view = await oneTank(tx, row.id);
        await writeAudit(tx, request, now, { action: "TANK_CREATED", entityType: "storage_tank", entityId: row.id, before: null, after: view });
        return view;
      });
      return reply.code(201).send({ tank });
    } catch (error) {
      if (violatedUnique(error) !== null) throw codeTaken(body.code);
      throw error;
    }
  });

  app.patch("/api/tanks/:id", level("EDIT"), async (request) => {
    const { id } = idParams.parse(request.params);
    const body = tankPatch.parse(request.body ?? {});
    const now = context.now();
    try {
      const tank = await orm.transaction(async (tx) => {
        const [current] = await tx.select().from(storageTanks).where(eq(storageTanks.id, id)).for("update");
        if (!current) throw notFound("Tangki");
        if (current.erpRef !== null && Object.entries(body).some(([key, value]) => key !== "isActive" && value !== undefined)) throw fromErp();
        await checkProduct(tx, body.productId);
        if (body.code !== undefined && body.code !== current.code) {
          const [taken] = await tx.select({ id: storageTanks.id }).from(storageTanks).where(and(eq(storageTanks.siteId, current.siteId), eq(storageTanks.code, body.code)));
          if (taken) throw codeTaken(body.code);
        }
        const before = await oneTank(tx, id);
        await tx
          .update(storageTanks)
          .set({
            ...(body.code === undefined ? {} : { code: body.code }),
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.productId === undefined ? {} : { productId: body.productId }),
            ...(body.capacityKg === undefined ? {} : { capacityKg: body.capacityKg }),
            ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
          })
          .where(eq(storageTanks.id, id));
        const after = await oneTank(tx, id);
        await writeAudit(tx, request, now, { action: "TANK_CHANGED", entityType: "storage_tank", entityId: id, before, after });
        return after;
      });
      return { tank };
    } catch (error) {
      if (violatedUnique(error) !== null && body.code) throw codeTaken(body.code);
      throw error;
    }
  });

  app.get("/api/seals", level("VIEW"), async (request) => {
    const query = sealQuery.parse(request.query);
    const site = await defaultSite(orm);
    const where = and(
      eq(seals.siteId, site.id),
      query.status ? eq(seals.status, query.status) : undefined,
      query.kind ? eq(seals.kind, query.kind) : undefined,
      query.q ? ilike(seals.sealNo, likeText(query.q)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(seals).where(where);
    return { items: await loadSeals(orm, where, query.limit, query.offset), total: counted?.total ?? 0 };
  });

  // a printed roll of seals: prefix + running number, zero-padded; numbers already in stock are skipped
  app.post("/api/seals/batch", level("CREATE"), async (request, reply) => {
    const body = sealBatch.parse(request.body ?? {});
    const now = context.now();
    const numberOf = (n: number) => `${body.prefix}${String(n).padStart(body.width, "0")}`;
    const first = numberOf(body.from);
    const last = numberOf(body.to);
    const result = await orm.transaction(async (tx) => {
      const site = await defaultSite(tx);
      const values = [];
      for (let n = body.from; n <= body.to; n++) values.push({ siteId: site.id, sealNo: numberOf(n), kind: body.kind, batchRef: `${first}..${last}`, createdAt: now });
      const made = await tx.insert(seals).values(values).onConflictDoNothing().returning({ id: seals.id });
      const answer = { created: made.length, skipped: values.length - made.length, first, last };
      await writeAudit(tx, request, now, { action: "SEALS_ADDED", entityType: "site", entityId: site.id, before: null, after: { kind: body.kind, ...answer } });
      return answer;
    });
    return reply.code(201).send(result);
  });

  app.patch("/api/seals/:id", level("EDIT"), async (request) => {
    const { id } = idParams.parse(request.params);
    sealPatch.parse(request.body ?? {});
    const now = context.now();
    const seal = await orm.transaction(async (tx) => {
      const [current] = await tx.select().from(seals).where(eq(seals.id, id)).for("update");
      if (!current) throw notFound("Segel");
      if (current.status !== "AVAILABLE") throw invalidState("Hanya segel yang belum dipakai yang bisa dibatalkan.");
      await tx.update(seals).set({ status: "VOID" }).where(eq(seals.id, id));
      await writeAudit(tx, request, now, { action: "SEAL_VOIDED", entityType: "seal", entityId: id, before: { status: current.status }, after: { status: "VOID" } });
      const [view] = await loadSeals(tx, eq(seals.id, id), 1, 0);
      return view;
    });
    return { seal };
  });
}
