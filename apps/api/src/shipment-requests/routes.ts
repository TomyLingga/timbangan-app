// Shipment requests (owner's flow of 25 November 2026, incoming step 1.1): the INL team picks a purchase contract,
// attaches the contract PDF (POST /api/shipment-requests/:id/files, in attachments/routes.ts) and sends the request
// to the supplier's accounts. A supplier account registers incoming trucks only for a contract with a SENT request
// (registrations/service.ts). One request covers one contract; a contract has at most one open request (0017).
// DRAFT -> SENT -> CLOSED; DRAFT or SENT -> CANCELLED.
import { and, count, eq, ilike, inArray, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import { shipmentRequestFilesOf } from "../attachments/view.js";
import type { Orm } from "../db/client.js";
import { erpContracts, partners, SHIPMENT_REQUEST_STATUSES, shipmentRequestFiles, shipmentRequests } from "../db/schema.js";
import { invalid, invalidState, notFound, refused, violatedUnique } from "../errors.js";
import { dateText, idNumber, idParams, likeText, limitParam, searchParam } from "../http.js";
import { notifyShipmentRequestSent } from "../notifications/service.js";
import { defaultSite } from "../settings.js";
import { listShipmentRequests, shipmentRequestsVisibleTo } from "./view.js";

const QTY_MESSAGE = "Quantity harus angka lebih dari 0.";
const fields = {
  contractId: idNumber,
  qtyPlanned: z.number(QTY_MESSAGE).positive(QTY_MESSAGE).max(1_000_000_000_000, QTY_MESSAGE).nullable().optional(),
  deliveryFrom: dateText("Tanggal mulai kirim").nullable().optional(),
  deliveryUntil: dateText("Tanggal akhir kirim").nullable().optional(),
  remark: z.string("Keterangan harus berupa teks.").trim().max(1000, "Keterangan terlalu panjang.").nullable().optional(),
};
const createBody = z.object(fields);
const patchBody = z.object({ ...fields, contractId: fields.contractId.optional() });
/** What may still change once the request has been sent. */
const LATE_FIELDS = new Set(["qtyPlanned", "deliveryUntil", "remark"]);
const listQuery = z.object({
  status: z.enum(SHIPMENT_REQUEST_STATUSES, "Status permintaan tidak dikenal.").optional(),
  contractId: idNumber.optional(),
  q: searchParam,
  limit: limitParam,
});
const reasonBody = z.object({ reason: z.string("Alasan wajib diisi.").trim().min(1, "Alasan wajib diisi.").max(500, "Alasan terlalu panjang.") });

const openExists = () => refused("SHIPMENT_REQUEST_EXISTS", "Kontrak ini sudah punya permintaan pengiriman yang masih terbuka.");
const OPEN_INDEX = "shipment_requests_open_contract";

/** The purchase contract of a request: open, direction IN. */
async function purchaseContract(orm: Orm, contractId: number) {
  const [contract] = await orm.select().from(erpContracts).where(eq(erpContracts.id, contractId));
  if (!contract || contract.direction !== "IN" || contract.state !== "OPEN") throw invalid("contractId", "Kontrak beli tidak ditemukan atau tidak terbuka.");
  return contract;
}

/** Refuses a second open request on the contract; `except` is the request being changed. */
async function assertNoOtherOpen(orm: Orm, contractId: number, except: number | null) {
  const open = await orm
    .select({ id: shipmentRequests.id })
    .from(shipmentRequests)
    .where(and(eq(shipmentRequests.contractId, contractId), inArray(shipmentRequests.status, ["DRAFT", "SENT"])));
  if (open.some((row) => row.id !== except)) throw openExists();
}

/** Turns the unique index of the open requests into SHIPMENT_REQUEST_EXISTS (two requests made at once). */
function rethrowOpen(error: unknown): never {
  if (violatedUnique(error) === OPEN_INDEX) throw openExists();
  throw error;
}

export function registerShipmentRequestRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const readers = { preHandler: [guards.authenticate, guards.requirePermission("shipment_requests", "VIEW")] };
  // a supplier account only reads, whatever its level
  const creators = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("shipment_requests", "CREATE")] };
  const editors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("shipment_requests", "EDIT")] };

  const one = async (db: Orm, id: number, account: Account) => {
    const [found] = await listShipmentRequests(db, and(eq(shipmentRequests.id, id), shipmentRequestsVisibleTo(account)), 1);
    if (!found) throw notFound("Permintaan pengiriman");
    return found;
  };
  const lock = async (db: Orm, id: number) => {
    const [row] = await db.select().from(shipmentRequests).where(eq(shipmentRequests.id, id)).for("update");
    if (!row) throw notFound("Permintaan pengiriman");
    return row;
  };
  const audit = (db: Orm, request: FastifyRequest, now: Date, id: number, action: string, before: unknown, after: unknown, reason?: string) =>
    writeAudit(db, request, now, { action, entityType: "shipment_request", entityId: id, before, after, ...(reason ? { reason } : {}) });

  app.get("/api/shipment-requests", readers, async (request) => {
    const query = listQuery.parse(request.query);
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      shipmentRequestsVisibleTo(accountOf(request)),
      query.status ? eq(shipmentRequests.status, query.status) : undefined,
      query.contractId ? eq(shipmentRequests.contractId, query.contractId) : undefined,
      pattern ? or(ilike(shipmentRequests.contractNo, pattern), ilike(partners.name, pattern)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(shipmentRequests).innerJoin(partners, eq(partners.id, shipmentRequests.partnerId)).where(where);
    return { items: await listShipmentRequests(orm, where, query.limit), total: counted?.total ?? 0 };
  });

  app.get("/api/shipment-requests/:id", readers, async (request) => {
    const { id } = idParams.parse(request.params);
    const shipmentRequest = await one(orm, id, accountOf(request));
    return { shipmentRequest, files: await shipmentRequestFilesOf(orm, id) };
  });

  app.post("/api/shipment-requests", creators, async (request, reply) => {
    const body = createBody.parse(request.body);
    const account = accountOf(request);
    const now = context.now();
    if (body.deliveryFrom && body.deliveryUntil && body.deliveryUntil < body.deliveryFrom) {
      throw invalid("deliveryUntil", "Tanggal akhir kirim tidak boleh sebelum tanggal mulai.");
    }
    const shipmentRequest = await orm
      .transaction(async (tx) => {
        const contract = await purchaseContract(tx, body.contractId);
        await assertNoOtherOpen(tx, contract.id, null);
        const siteId = contract.siteId ?? (await defaultSite(tx)).id;
        const [created] = await tx
          .insert(shipmentRequests)
          .values({
            siteId,
            contractId: contract.id,
            contractNo: contract.contractNo,
            partnerId: contract.partnerId,
            qtyPlanned: body.qtyPlanned ?? null,
            deliveryFrom: body.deliveryFrom ?? null,
            deliveryUntil: body.deliveryUntil ?? null,
            remark: body.remark || null,
            createdBy: account.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: shipmentRequests.id });
        if (!created) throw new Error("The shipment request was not created.");
        await audit(tx, request, now, created.id, "SHIPMENT_REQUEST_CREATED", null, { status: "DRAFT", contractId: contract.id });
        return one(tx, created.id, account);
      })
      .catch(rethrowOpen);
    return reply.code(201).send({ shipmentRequest });
  });

  app.patch("/api/shipment-requests/:id", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const shipmentRequest = await orm
      .transaction(async (tx) => {
        const current = await lock(tx, id);
        const given = Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined);
        if (current.status === "SENT") {
          if (given.some((key) => !LATE_FIELDS.has(key))) throw invalidState("Setelah permintaan dikirim, hanya quantity, tanggal akhir kirim, dan keterangan yang boleh diubah.");
        } else if (current.status !== "DRAFT") {
          throw invalidState("Permintaan yang sudah ditutup atau dibatalkan tidak bisa diubah.");
        }
        const changes: Partial<typeof shipmentRequests.$inferInsert> = {};
        if (body.contractId !== undefined && body.contractId !== current.contractId) {
          const contract = await purchaseContract(tx, body.contractId);
          await assertNoOtherOpen(tx, contract.id, id);
          Object.assign(changes, { contractId: contract.id, contractNo: contract.contractNo, partnerId: contract.partnerId, siteId: contract.siteId ?? current.siteId });
        }
        if (body.qtyPlanned !== undefined) changes.qtyPlanned = body.qtyPlanned;
        if (body.deliveryFrom !== undefined) changes.deliveryFrom = body.deliveryFrom;
        if (body.deliveryUntil !== undefined) changes.deliveryUntil = body.deliveryUntil;
        if (body.remark !== undefined) changes.remark = body.remark || null;
        const from = changes.deliveryFrom !== undefined ? changes.deliveryFrom : current.deliveryFrom;
        const until = changes.deliveryUntil !== undefined ? changes.deliveryUntil : current.deliveryUntil;
        if (from && until && until < from) throw invalid("deliveryUntil", "Tanggal akhir kirim tidak boleh sebelum tanggal mulai.");
        if (Object.keys(changes).length === 0) return one(tx, id, account);
        await tx.update(shipmentRequests).set({ ...changes, updatedAt: now }).where(eq(shipmentRequests.id, id));
        const before = Object.fromEntries(Object.keys(changes).map((key) => [key, current[key as keyof typeof current]]));
        await audit(tx, request, now, id, "SHIPMENT_REQUEST_CHANGED", before, changes);
        return one(tx, id, account);
      })
      .catch(rethrowOpen);
    return { shipmentRequest };
  });

  app.post("/api/shipment-requests/:id/send", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const shipmentRequest = await orm.transaction(async (tx) => {
      const current = await lock(tx, id);
      if (current.status !== "DRAFT") throw invalidState("Hanya permintaan berstatus DRAFT yang bisa dikirim.");
      const [contract] = await tx.select({ state: erpContracts.state }).from(erpContracts).where(eq(erpContracts.id, current.contractId));
      if (contract?.state !== "OPEN") throw invalidState("Kontrak permintaan ini sudah tidak terbuka.");
      const [held] = await tx.select({ n: count() }).from(shipmentRequestFiles).where(eq(shipmentRequestFiles.shipmentRequestId, id));
      if ((held?.n ?? 0) === 0) throw refused("FILE_REQUIRED", "Lampirkan dokumen kontrak sebelum permintaan dikirim.");
      await tx.update(shipmentRequests).set({ status: "SENT", sentBy: account.id, sentAt: now, updatedAt: now }).where(eq(shipmentRequests.id, id));
      await audit(tx, request, now, id, "SHIPMENT_REQUEST_SENT", { status: current.status }, { status: "SENT", partnerId: current.partnerId });
      // the supplier's accounts see it in their inbox, and on their phones once the sender loop runs
      await notifyShipmentRequestSent(tx, { id, contractNo: current.contractNo, siteId: current.siteId, partnerId: current.partnerId }, now);
      return one(tx, id, account);
    });
    return { shipmentRequest };
  });

  app.post("/api/shipment-requests/:id/close", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const shipmentRequest = await orm.transaction(async (tx) => {
      const current = await lock(tx, id);
      if (current.status !== "SENT") throw invalidState("Hanya permintaan berstatus SENT yang bisa ditutup.");
      await tx.update(shipmentRequests).set({ status: "CLOSED", closedBy: account.id, closedAt: now, updatedAt: now }).where(eq(shipmentRequests.id, id));
      await audit(tx, request, now, id, "SHIPMENT_REQUEST_CLOSED", { status: current.status }, { status: "CLOSED" });
      return one(tx, id, account);
    });
    return { shipmentRequest };
  });

  app.post("/api/shipment-requests/:id/cancel", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = reasonBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const shipmentRequest = await orm.transaction(async (tx) => {
      const current = await lock(tx, id);
      if (current.status !== "DRAFT" && current.status !== "SENT") throw invalidState("Permintaan ini sudah ditutup atau dibatalkan.");
      await tx
        .update(shipmentRequests)
        .set({ status: "CANCELLED", cancelledBy: account.id, cancelledAt: now, cancelReason: reason, updatedAt: now })
        .where(eq(shipmentRequests.id, id));
      await audit(tx, request, now, id, "SHIPMENT_REQUEST_CANCELLED", { status: current.status }, { status: "CANCELLED" }, reason);
      return one(tx, id, account);
    });
    return { shipmentRequest };
  });
}
