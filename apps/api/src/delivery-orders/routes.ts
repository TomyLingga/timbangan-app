// Delivery orders (DO): written by the logistics admin, sent to one transporter, accepted by it, closed.
import { and, count, desc, eq, ilike, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { deliveryOrders, destinations, erpContracts, partners, products, registrationAllocations, spjDocuments, tripAllocations, trips } from "../db/schema.js";
import { AppError, duplicate, forbidden, invalid, invalidState, notFound } from "../errors.js";
import { dateText, idNumber, idParams, likeText, limitParam, searchParam } from "../http.js";
import { nextDoNumber } from "../numbering.js";
import { defaultSite, readSetting } from "../settings.js";
import { ARRIVED_STATUSES, expireDueTrips, loadTrips } from "../trips/view.js";

const DEFAULT_DO_FORMAT = "{seq:3}/DO/{site}/{roman}/{yyyy}";
const STATUSES = ["DRAFT", "SENT", "ACCEPTED", "CLOSED", "CANCELLED"] as const;
const ADMIN_ROLES = ["SUPER_ADMIN", "LOGISTICS_ADMIN"];

const optionalText = (label: string, max: number) => z.string(`${label} harus berupa teks.`).trim().max(max, `${label} terlalu panjang.`).nullable().optional();
const QTY_MESSAGE = "Quantity harus angka lebih dari 0.";
const TRUCKS_MESSAGE = "Jumlah truk harus antara 1 dan 500.";
const truckCount = z.number(TRUCKS_MESSAGE).int(TRUCKS_MESSAGE).min(1, TRUCKS_MESSAGE).max(500, TRUCKS_MESSAGE);
const fields = {
  doNo: z.string("Nomor DO harus berupa teks.").trim().min(1, "Nomor DO tidak boleh kosong.").max(60, "Nomor DO terlalu panjang.").optional(),
  doDate: dateText("Tanggal DO"),
  contractId: idNumber.nullable().optional(),
  partnerId: idNumber.optional(),
  productId: idNumber.optional(),
  customerPoNo: optionalText("Nomor PO customer", 100),
  qty: z.number(QTY_MESSAGE).positive(QTY_MESSAGE).max(1_000_000_000_000, QTY_MESSAGE),
  uom: z.string("Satuan harus berupa teks.").trim().min(1, "Satuan tidak boleh kosong.").max(20, "Satuan terlalu panjang.").optional(),
  tolerancePct: z.number("Toleransi harus angka.").min(0, "Toleransi tidak boleh negatif.").max(100, "Toleransi paling besar 100.").optional(),
  destinationId: idNumber,
  deliveryFrom: dateText("Tanggal mulai kirim"),
  deliveryUntil: dateText("Tanggal akhir kirim").nullable().optional(),
  transportTerms: optionalText("Syarat angkut", 50),
  transporterId: idNumber.nullable().optional(),
  truckCount: truckCount.nullable().optional(),
  remark: optionalText("Keterangan", 1000),
};
const createBody = z.object(fields);
const patchBody = z.object({ ...fields, doDate: fields.doDate.optional(), qty: fields.qty.optional(), destinationId: fields.destinationId.optional(), deliveryFrom: fields.deliveryFrom.optional() });
/** What may still change once a DO has been sent. */
const LATE_FIELDS = new Set(["deliveryUntil", "truckCount", "remark"]);
const listQuery = z.object({ status: z.enum(STATUSES, "Status DO tidak dikenal.").optional(), q: searchParam, limit: limitParam });
const sendBody = z.object({ transporterId: idNumber.optional() });
const acceptBody = z.object({ truckCount: truckCount.optional() });
const reasonBody = z.object({ reason: z.string("Alasan wajib diisi.").trim().min(1, "Alasan wajib diisi.").max(500, "Alasan terlalu panjang.") });

const transporterOf = alias(partners, "do_transporter");

/** Quantity planned on the DO by trips that still hold it, and how many such trips there are. */
const plannedSql = sql<number>`(select coalesce(sum(ta.qty_planned), 0) from trip_allocations ta
  join registration_allocations ra on ra.id = ta.registration_allocation_id
  join trips t on t.id = ta.trip_id
  where ra.delivery_order_id = ${deliveryOrders.id} and t.status not in ('CANCELLED', 'EXPIRED', 'REJECTED'))`.mapWith(Number);
const tripCountSql = sql<number>`(select count(distinct t.id) from trip_allocations ta
  join registration_allocations ra on ra.id = ta.registration_allocation_id
  join trips t on t.id = ta.trip_id
  where ra.delivery_order_id = ${deliveryOrders.id} and t.status not in ('CANCELLED', 'EXPIRED', 'REJECTED'))`.mapWith(Number);

export async function listDeliveryOrders(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm
    .select({
      order: deliveryOrders,
      partnerName: partners.name,
      productName: products.name,
      productCategory: products.category,
      destination: { id: destinations.id, name: destinations.name, address: destinations.address, district: destinations.district, regency: destinations.regency, province: destinations.province },
      transporterName: transporterOf.name,
      qtyPlanned: plannedSql,
      tripCount: tripCountSql,
    })
    .from(deliveryOrders)
    .innerJoin(partners, eq(partners.id, deliveryOrders.partnerId))
    .innerJoin(products, eq(products.id, deliveryOrders.productId))
    .innerJoin(destinations, eq(destinations.id, deliveryOrders.destinationId))
    .leftJoin(transporterOf, eq(transporterOf.id, deliveryOrders.transporterId))
    .where(where)
    .orderBy(desc(deliveryOrders.createdAt), desc(deliveryOrders.id))
    .limit(limit);
  return rows.map(({ order, ...row }) => ({
    id: order.id,
    doNo: order.doNo,
    doDate: order.doDate,
    status: order.status,
    contract: order.contractId !== null ? { id: order.contractId, contractNo: order.contractNo } : null,
    customerPoNo: order.customerPoNo,
    partner: { id: order.partnerId, name: row.partnerName },
    product: { id: order.productId, name: row.productName, category: row.productCategory },
    qty: order.qty,
    uom: order.uom,
    tolerancePct: order.tolerancePct,
    destination: row.destination,
    deliveryFrom: order.deliveryFrom,
    deliveryUntil: order.deliveryUntil,
    transportTerms: order.transportTerms,
    transporter: order.transporterId !== null && row.transporterName !== null ? { id: order.transporterId, name: row.transporterName } : null,
    truckCount: order.truckCount,
    truckCountBy: order.truckCountBy,
    qtyPlanned: row.qtyPlanned,
    qtyRemaining: Math.round((order.qty - row.qtyPlanned) * 1000) / 1000,
    tripCount: row.tripCount,
    remark: order.remark,
    sentAt: order.sentAt,
    acceptedAt: order.acceptedAt,
  }));
}

/** What a partner account may see: DOs sent to its own company. Staff see every DO. */
export const visibleTo = (account: Account): SQL | undefined =>
  account.kind === "PARTNER" ? and(eq(deliveryOrders.transporterId, account.partner?.id ?? -1), ne(deliveryOrders.status, "DRAFT")) : undefined;

type Values = Omit<z.infer<typeof createBody>, "doNo">;

/** Checks the references and fills what the sales contract decides. Collects every field error at once. */
async function resolve(orm: Orm, input: Values) {
  const errors: { field: string; message: string }[] = [];
  let partnerId = input.partnerId;
  let productId = input.productId;
  let contractNo: string | null = null;
  let customerPoNo = input.customerPoNo ?? null;
  let uom = input.uom;
  let tolerancePct = input.tolerancePct;
  if (input.contractId !== undefined && input.contractId !== null) {
    const [contract] = await orm.select().from(erpContracts).where(eq(erpContracts.id, input.contractId));
    if (!contract || contract.direction !== "OUT" || contract.state !== "OPEN") {
      errors.push({ field: "contractId", message: "Kontrak jual tidak ditemukan atau tidak terbuka." });
    } else {
      partnerId = contract.partnerId;
      productId = contract.productId;
      contractNo = contract.contractNo;
      customerPoNo = input.customerPoNo ?? contract.customerPoNo;
      uom ??= contract.uom;
      tolerancePct ??= contract.tolerancePct;
    }
  } else {
    if (partnerId === undefined) errors.push({ field: "partnerId", message: "Partner wajib diisi bila DO tanpa kontrak." });
    if (productId === undefined) errors.push({ field: "productId", message: "Produk wajib diisi bila DO tanpa kontrak." });
  }
  if (partnerId !== undefined && !errors.some((error) => error.field === "contractId")) {
    const [partner] = await orm.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId));
    if (!partner) errors.push({ field: "partnerId", message: "Partner tidak ditemukan." });
  }
  if (productId !== undefined) {
    const [product] = await orm.select({ uom: products.uom }).from(products).where(eq(products.id, productId));
    if (!product) errors.push({ field: "productId", message: "Produk tidak ditemukan." });
    else uom ??= product.uom;
  }
  const [destination] = await orm.select({ partnerId: destinations.partnerId, isActive: destinations.isActive }).from(destinations).where(eq(destinations.id, input.destinationId));
  if (!destination?.isActive || (destination.partnerId !== null && destination.partnerId !== partnerId)) {
    errors.push({ field: "destinationId", message: "Tujuan tidak ditemukan atau bukan tujuan partner ini." });
  }
  if (input.transporterId !== undefined && input.transporterId !== null && !(await isTransporter(orm, input.transporterId))) {
    errors.push({ field: "transporterId", message: "Transporter harus partner transporter." });
  }
  if (input.deliveryUntil && input.deliveryUntil < input.deliveryFrom) errors.push({ field: "deliveryUntil", message: "Tanggal akhir kirim tidak boleh sebelum tanggal mulai." });
  if (errors.length > 0 || partnerId === undefined || productId === undefined) throw new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", errors);
  return {
    doDate: input.doDate,
    contractId: input.contractId ?? null,
    contractNo,
    customerPoNo,
    partnerId,
    productId,
    qty: input.qty,
    uom: uom ?? "kg",
    tolerancePct: tolerancePct ?? 0,
    destinationId: input.destinationId,
    deliveryFrom: input.deliveryFrom,
    deliveryUntil: input.deliveryUntil ?? null,
    transportTerms: input.transportTerms ?? null,
    transporterId: input.transporterId ?? null,
    truckCount: input.truckCount ?? null,
    truckCountBy: input.truckCount === undefined || input.truckCount === null ? null : ("ADMIN" as const),
    remark: input.remark ?? null,
  };
}

async function isTransporter(orm: Orm, partnerId: number): Promise<boolean> {
  const [partner] = await orm.select({ isTransporter: partners.isTransporter }).from(partners).where(eq(partners.id, partnerId));
  return partner?.isTransporter === true;
}

/** Cancels the trips of the DO that have not arrived and revokes their SPJ. */
async function releaseTrips(orm: Orm, deliveryOrderId: number, actor: number, now: Date, reason: string) {
  const open = await orm
    .selectDistinct({ id: trips.id })
    .from(trips)
    .innerJoin(tripAllocations, eq(tripAllocations.tripId, trips.id))
    .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
    .where(and(eq(registrationAllocations.deliveryOrderId, deliveryOrderId), inArray(trips.status, ["DRAFT", "READY", "ISSUED", "EXPIRED"])));
  const ids = open.map((row) => row.id);
  if (ids.length === 0) return;
  await orm.update(trips).set({ status: "CANCELLED", cancelledAt: now, cancelReason: reason, updatedAt: now }).where(inArray(trips.id, ids));
  await orm
    .update(spjDocuments)
    .set({ revokedAt: now, revokedBy: actor, revokeReason: reason })
    .where(and(inArray(spjDocuments.tripId, ids), sql`${spjDocuments.revokedAt} is null`));
}

export function registerDeliveryOrderRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const readers = { preHandler: [guards.authenticate, guards.requireRole()] };
  const admins = { preHandler: [guards.authenticate, guards.requireRole(...ADMIN_ROLES)] };

  const one = async (db: Orm, id: number, account: Account) => {
    const [order] = await listDeliveryOrders(db, and(eq(deliveryOrders.id, id), visibleTo(account)), 1);
    if (!order) throw notFound("DO");
    return order;
  };
  /** Locks the DO row for a status change; 404 when the account cannot see it. */
  const lock = async (db: Orm, id: number, account: Account) => {
    const [row] = await db.select().from(deliveryOrders).where(and(eq(deliveryOrders.id, id), visibleTo(account))).for("update");
    if (!row) throw notFound("DO");
    return row;
  };
  const audit = (db: Orm, request: FastifyRequest, now: Date, id: number, action: string, before: unknown, after: unknown, reason?: string) =>
    writeAudit(db, request, now, { action, entityType: "delivery_order", entityId: id, before, after, ...(reason ? { reason } : {}) });

  app.get("/api/delivery-orders", readers, async (request) => {
    const query = listQuery.parse(request.query);
    const account = accountOf(request);
    await expireDueTrips(orm, context.now());
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      visibleTo(account),
      query.status ? eq(deliveryOrders.status, query.status) : undefined,
      pattern
        ? or(ilike(deliveryOrders.doNo, pattern), ilike(deliveryOrders.contractNo, pattern), ilike(deliveryOrders.customerPoNo, pattern), ilike(partners.name, pattern))
        : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(deliveryOrders).innerJoin(partners, eq(partners.id, deliveryOrders.partnerId)).where(where);
    return { items: await listDeliveryOrders(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.get("/api/delivery-orders/:id", readers, async (request) => {
    const { id } = idParams.parse(request.params);
    await expireDueTrips(orm, context.now());
    const deliveryOrder = await one(orm, id, accountOf(request));
    const tripIds = await orm
      .selectDistinct({ id: trips.id, registrationId: trips.registrationId, seq: trips.seq })
      .from(trips)
      .innerJoin(tripAllocations, eq(tripAllocations.tripId, trips.id))
      .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
      .where(eq(registrationAllocations.deliveryOrderId, id))
      .orderBy(trips.registrationId, trips.seq);
    return { deliveryOrder, trips: await loadTrips(orm, tripIds.map((row) => row.id)) };
  });

  app.post("/api/delivery-orders", admins, async (request, reply) => {
    const { doNo, ...body } = createBody.parse(request.body);
    const account = accountOf(request);
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const values = await resolve(tx, body);
      const site = await defaultSite(tx);
      let number = doNo;
      if (number !== undefined) {
        const [taken] = await tx.select({ id: deliveryOrders.id }).from(deliveryOrders).where(eq(deliveryOrders.doNo, number));
        if (taken) throw duplicate(`Nomor DO ${number} sudah dipakai.`);
      } else {
        const format = (await readSetting<string>(tx, site.id, "do_number_format")) ?? DEFAULT_DO_FORMAT;
        // a number typed earlier may already hold the next one of the series: take the one after it
        for (let attempt = 0; attempt < 1000 && number === undefined; attempt++) {
          const candidate = await nextDoNumber(tx, format, site.code, now);
          const [taken] = await tx.select({ id: deliveryOrders.id }).from(deliveryOrders).where(eq(deliveryOrders.doNo, candidate));
          if (!taken) number = candidate;
        }
        if (number === undefined) throw new Error("No free DO number was found.");
      }
      const [created] = await tx
        .insert(deliveryOrders)
        .values({ ...values, doNo: number, siteId: site.id, createdBy: account.id, createdAt: now, updatedAt: now })
        .returning({ id: deliveryOrders.id });
      if (!created) throw new Error("The DO was not created.");
      return one(tx, created.id, account);
    });
    return reply.code(201).send({ deliveryOrder });
  });

  app.patch("/api/delivery-orders/:id", admins, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const account = accountOf(request);
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      const given = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
      if (current.status === "DRAFT") {
        const { doNo, ...changes } = given as Partial<z.infer<typeof createBody>>;
        if (doNo !== undefined && doNo !== current.doNo) {
          const [taken] = await tx.select({ id: deliveryOrders.id }).from(deliveryOrders).where(eq(deliveryOrders.doNo, doNo));
          if (taken) throw duplicate(`Nomor DO ${doNo} sudah dipakai.`);
        }
        const merged: Values = {
          doDate: current.doDate,
          contractId: current.contractId,
          partnerId: current.partnerId,
          productId: current.productId,
          customerPoNo: current.contractId === (changes.contractId ?? current.contractId) ? current.customerPoNo : undefined,
          qty: current.qty,
          uom: current.contractId === (changes.contractId ?? current.contractId) ? current.uom : undefined,
          tolerancePct: current.contractId === (changes.contractId ?? current.contractId) ? current.tolerancePct : undefined,
          destinationId: current.destinationId,
          deliveryFrom: current.deliveryFrom,
          deliveryUntil: current.deliveryUntil,
          transportTerms: current.transportTerms,
          transporterId: current.transporterId,
          truckCount: current.truckCount,
          remark: current.remark,
          ...changes,
        };
        const values = await resolve(tx, merged);
        await tx.update(deliveryOrders).set({ ...values, ...(doNo !== undefined ? { doNo } : {}), updatedAt: now }).where(eq(deliveryOrders.id, id));
      } else if (current.status === "SENT" || current.status === "ACCEPTED") {
        const locked = Object.keys(given).filter((key) => !LATE_FIELDS.has(key));
        if (locked.length > 0) throw invalidState("Setelah DO dikirim, hanya tanggal akhir kirim, jumlah truk, dan keterangan yang boleh diubah.");
        const deliveryUntil = body.deliveryUntil === undefined ? current.deliveryUntil : body.deliveryUntil;
        if (deliveryUntil && deliveryUntil < current.deliveryFrom) throw invalid("deliveryUntil", "Tanggal akhir kirim tidak boleh sebelum tanggal mulai.");
        await tx
          .update(deliveryOrders)
          .set({
            ...(body.deliveryUntil !== undefined ? { deliveryUntil: body.deliveryUntil } : {}),
            ...(body.remark !== undefined ? { remark: body.remark } : {}),
            ...(body.truckCount !== undefined ? { truckCount: body.truckCount, truckCountBy: body.truckCount === null ? null : "ADMIN" } : {}),
            updatedAt: now,
          })
          .where(eq(deliveryOrders.id, id));
      } else {
        throw invalidState("DO yang sudah ditutup atau dibatalkan tidak bisa diubah.");
      }
      return one(tx, id, account);
    });
    return { deliveryOrder };
  });

  app.post("/api/delivery-orders/:id/send", admins, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = sendBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "DRAFT") throw invalidState("Hanya DO berstatus DRAFT yang bisa dikirim.");
      const transporterId = body.transporterId ?? current.transporterId;
      if (transporterId === null) throw invalid("transporterId", "Pilih transporter sebelum DO dikirim.");
      if (!(await isTransporter(tx, transporterId))) throw invalid("transporterId", "Transporter harus partner transporter.");
      await tx.update(deliveryOrders).set({ status: "SENT", transporterId, sentAt: now, updatedAt: now }).where(eq(deliveryOrders.id, id));
      await audit(tx, request, now, id, "DO_SENT", { status: current.status }, { status: "SENT", transporterId });
      return one(tx, id, account);
    });
    return { deliveryOrder };
  });

  app.post("/api/delivery-orders/:id/accept", readers, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = acceptBody.parse(request.body ?? {});
    const account = accountOf(request);
    const allowed = account.kind === "PARTNER" ? account.roles.includes("PARTNER_TRANSPORTER") : account.roles.some((role) => ADMIN_ROLES.includes(role));
    if (!allowed) throw forbidden();
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "SENT") throw invalidState("Hanya DO berstatus SENT yang bisa diterima.");
      // the transporter fills the truck count only when the admin left it empty
      const truckCount = current.truckCount === null && body.truckCount !== undefined ? { truckCount: body.truckCount, truckCountBy: "TRANSPORTER" as const } : {};
      await tx.update(deliveryOrders).set({ status: "ACCEPTED", acceptedBy: account.id, acceptedAt: now, updatedAt: now, ...truckCount }).where(eq(deliveryOrders.id, id));
      await audit(tx, request, now, id, "DO_ACCEPTED", { status: current.status }, { status: "ACCEPTED", ...truckCount });
      return one(tx, id, account);
    });
    return { deliveryOrder };
  });

  app.post("/api/delivery-orders/:id/close", admins, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "ACCEPTED") throw invalidState("Hanya DO berstatus ACCEPTED yang bisa ditutup.");
      await tx.update(deliveryOrders).set({ status: "CLOSED", closedAt: now, updatedAt: now }).where(eq(deliveryOrders.id, id));
      await audit(tx, request, now, id, "DO_CLOSED", { status: current.status }, { status: "CLOSED" });
      return one(tx, id, account);
    });
    return { deliveryOrder };
  });

  app.post("/api/delivery-orders/:id/cancel", admins, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = reasonBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const deliveryOrder = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (!["DRAFT", "SENT", "ACCEPTED"].includes(current.status)) throw invalidState("DO ini sudah ditutup atau dibatalkan.");
      const [arrived] = await tx
        .select({ id: trips.id })
        .from(trips)
        .innerJoin(tripAllocations, eq(tripAllocations.tripId, trips.id))
        .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
        .where(and(eq(registrationAllocations.deliveryOrderId, id), inArray(trips.status, ARRIVED_STATUSES)))
        .limit(1);
      if (arrived) throw invalidState("DO tidak bisa dibatalkan: sudah ada truk yang check-in.");
      await releaseTrips(tx, id, account.id, now, reason);
      await tx.update(deliveryOrders).set({ status: "CANCELLED", cancelReason: reason, updatedAt: now }).where(eq(deliveryOrders.id, id));
      await audit(tx, request, now, id, "DO_CANCELLED", { status: current.status }, { status: "CANCELLED" }, reason);
      return one(tx, id, account);
    });
    return { deliveryOrder };
  });
}

