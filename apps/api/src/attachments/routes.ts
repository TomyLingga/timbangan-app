// Files attached to a delivery order (the DO letter logistics sends with it), to a shipment request (the contract
// PDF sent to the supplier) and weighbridge slips attached to a
// truck of an incoming registration (the supplier's own scale, label SLIP_TIMBANG). The files themselves are
// uploaded through POST /api/files; these routes link and unlink them.
import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, can, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { deliveryOrderFiles, deliveryOrders, files, registrations, shipmentRequestFiles, shipmentRequests, tripFiles, trips, users } from "../db/schema.js";
import { deliveryOrderFilesOf, SLIP_LABEL, shipmentRequestFilesOf, tripSlipsOf } from "./view.js";
import { duplicate, forbidden, invalid, invalidState, notFound, refused } from "../errors.js";
import { idNumber, idParams } from "../http.js";
import { registrationsVisibleTo } from "../registrations/view.js";
import { mayWrite } from "../registrations/service.js";

export const MAX_DO_FILES = 5;
export const MAX_REQUEST_FILES = 5;
export const MAX_TRIP_SLIPS = 3;

const linkBody = z.object({
  fileId: idNumber,
  label: z.string("Label harus berupa teks.").trim().max(60, "Label terlalu panjang.").optional(),
});
const doFileParams = z.object({ id: idNumber, fileId: idNumber });
const tripParams = z.object({ id: idNumber, tripId: idNumber });
const tripFileParams = tripParams.extend({ fileId: idNumber });

/** The uploader of a file: staff, or the company of a partner account; null when the file does not exist. */
async function uploaderOf(orm: Orm, fileId: number) {
  const [row] = await orm
    .select({ id: files.id, kind: users.kind, partnerId: users.partnerId })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(eq(files.id, fileId));
  return row ?? null;
}

/** Whether the file is linked to any truck, delivery order or shipment request already. */
export async function linkedAnywhere(orm: Orm, fileId: number): Promise<boolean> {
  const [onTrip] = await orm.select({ n: count() }).from(tripFiles).where(eq(tripFiles.fileId, fileId));
  const [onDo] = await orm.select({ n: count() }).from(deliveryOrderFiles).where(eq(deliveryOrderFiles.fileId, fileId));
  const [onRequest] = await orm.select({ n: count() }).from(shipmentRequestFiles).where(eq(shipmentRequestFiles.fileId, fileId));
  return (onTrip?.n ?? 0) + (onDo?.n ?? 0) + (onRequest?.n ?? 0) > 0;
}

const unknownFile = () => invalid("fileId", "Berkas tidak ditemukan.");
const alreadyUsed = () => duplicate("Berkas ini sudah dilampirkan.");

export function registerAttachmentRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const doEditors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("delivery_orders", "CREATE")] };
  // partners need CREATE (their default); staff need EDIT, checked in the handler
  const staffNeedEdit = async (request: FastifyRequest) => {
    const account = accountOf(request);
    if (account.kind === "INTERNAL" && !can(account, "registrations", "EDIT")) throw forbidden();
  };
  const slipEditors = { preHandler: [guards.authenticate, guards.requirePermission("registrations", "CREATE"), staffNeedEdit] };

  /** Locks the DO for a change of its files: only a draft or a sent one. */
  const lockDo = async (tx: Orm, id: number) => {
    const [order] = await tx.select().from(deliveryOrders).where(eq(deliveryOrders.id, id)).for("update");
    if (!order) throw notFound("DO");
    if (order.status !== "DRAFT" && order.status !== "SENT") throw invalidState("Lampiran DO hanya bisa diubah selama DO berstatus DRAFT atau SENT.");
    return order;
  };

  app.post("/api/delivery-orders/:id/files", doEditors, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = linkBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      await lockDo(tx, id);
      const uploader = await uploaderOf(tx, body.fileId);
      // a partner's upload is never handed to another company through a DO
      if (!uploader || uploader.kind !== "INTERNAL") throw unknownFile();
      const [mine] = await tx.select({ n: count() }).from(deliveryOrderFiles).where(and(eq(deliveryOrderFiles.deliveryOrderId, id), eq(deliveryOrderFiles.fileId, body.fileId)));
      if ((mine?.n ?? 0) > 0) throw alreadyUsed();
      if (await linkedAnywhere(tx, body.fileId)) throw invalid("fileId", "Berkas ini sudah dipakai di tempat lain.");
      const [held] = await tx.select({ n: count() }).from(deliveryOrderFiles).where(eq(deliveryOrderFiles.deliveryOrderId, id));
      if ((held?.n ?? 0) >= MAX_DO_FILES) throw refused("TOO_MANY_FILES", `Paling banyak ${MAX_DO_FILES} lampiran per DO.`);
      await tx.insert(deliveryOrderFiles).values({ deliveryOrderId: id, fileId: body.fileId, label: body.label || null, addedBy: account.id, addedAt: now });
      await writeAudit(tx, request, now, { action: "DO_FILE_ADDED", entityType: "delivery_order", entityId: id, before: null, after: { fileId: body.fileId, label: body.label ?? null } });
      return deliveryOrderFilesOf(tx, id);
    });
    return reply.code(201).send({ files: list });
  });

  app.delete("/api/delivery-orders/:id/files/:fileId", doEditors, async (request) => {
    const { id, fileId } = doFileParams.parse(request.params);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      await lockDo(tx, id);
      const removed = await tx
        .delete(deliveryOrderFiles)
        .where(and(eq(deliveryOrderFiles.deliveryOrderId, id), eq(deliveryOrderFiles.fileId, fileId)))
        .returning({ fileId: deliveryOrderFiles.fileId });
      if (removed.length === 0) throw notFound("Lampiran");
      await writeAudit(tx, request, now, { action: "DO_FILE_REMOVED", entityType: "delivery_order", entityId: id, before: { fileId }, after: null });
      return deliveryOrderFilesOf(tx, id);
    });
    return { files: list };
  });

  const requestEditors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("shipment_requests", "CREATE")] };

  /** Locks the shipment request for a change of its files: only a draft or a sent one. */
  const lockRequest = async (tx: Orm, id: number) => {
    const [request] = await tx.select().from(shipmentRequests).where(eq(shipmentRequests.id, id)).for("update");
    if (!request) throw notFound("Permintaan pengiriman");
    if (request.status !== "DRAFT" && request.status !== "SENT") throw invalidState("Lampiran hanya bisa diubah selama permintaan berstatus DRAFT atau SENT.");
    return request;
  };

  app.post("/api/shipment-requests/:id/files", requestEditors, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = linkBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      await lockRequest(tx, id);
      const uploader = await uploaderOf(tx, body.fileId);
      // a partner's upload is never handed to another company through a request
      if (!uploader || uploader.kind !== "INTERNAL") throw unknownFile();
      const [mine] = await tx
        .select({ n: count() })
        .from(shipmentRequestFiles)
        .where(and(eq(shipmentRequestFiles.shipmentRequestId, id), eq(shipmentRequestFiles.fileId, body.fileId)));
      if ((mine?.n ?? 0) > 0) throw alreadyUsed();
      if (await linkedAnywhere(tx, body.fileId)) throw invalid("fileId", "Berkas ini sudah dipakai di tempat lain.");
      const [held] = await tx.select({ n: count() }).from(shipmentRequestFiles).where(eq(shipmentRequestFiles.shipmentRequestId, id));
      if ((held?.n ?? 0) >= MAX_REQUEST_FILES) throw refused("TOO_MANY_FILES", `Paling banyak ${MAX_REQUEST_FILES} lampiran per permintaan.`);
      await tx.insert(shipmentRequestFiles).values({ shipmentRequestId: id, fileId: body.fileId, label: body.label || null, addedBy: account.id, addedAt: now });
      await writeAudit(tx, request, now, {
        action: "SHIPMENT_REQUEST_FILE_ADDED",
        entityType: "shipment_request",
        entityId: id,
        before: null,
        after: { fileId: body.fileId, label: body.label ?? null },
      });
      return shipmentRequestFilesOf(tx, id);
    });
    return reply.code(201).send({ files: list });
  });

  app.delete("/api/shipment-requests/:id/files/:fileId", requestEditors, async (request) => {
    const { id, fileId } = doFileParams.parse(request.params);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      const current = await lockRequest(tx, id);
      const removed = await tx
        .delete(shipmentRequestFiles)
        .where(and(eq(shipmentRequestFiles.shipmentRequestId, id), eq(shipmentRequestFiles.fileId, fileId)))
        .returning({ fileId: shipmentRequestFiles.fileId });
      if (removed.length === 0) throw notFound("Lampiran");
      // the supplier keeps the contract document it was sent: add the new file first, then remove the old one
      const [left] = await tx.select({ n: count() }).from(shipmentRequestFiles).where(eq(shipmentRequestFiles.shipmentRequestId, id));
      if (current.status === "SENT" && (left?.n ?? 0) === 0) throw refused("FILE_REQUIRED", "Permintaan yang sudah dikirim harus tetap punya satu lampiran.");
      await writeAudit(tx, request, now, { action: "SHIPMENT_REQUEST_FILE_REMOVED", entityType: "shipment_request", entityId: id, before: { fileId }, after: null });
      return shipmentRequestFilesOf(tx, id);
    });
    return { files: list };
  });

  /**
   * Locks the registration and finds the truck for a change of its slips. A partner changes the slips of its own
   * draft; staff with registrations EDIT while the registration is open. 404 when the account cannot see it.
   */
  const lockTrip = async (tx: Orm, account: Account, id: number, tripId: number) => {
    const [registration] = await tx.select().from(registrations).where(and(eq(registrations.id, id), registrationsVisibleTo(account))).for("update");
    if (!registration) throw notFound("Registrasi");
    const [trip] = await tx.select({ id: trips.id }).from(trips).where(and(eq(trips.id, tripId), eq(trips.registrationId, id)));
    if (!trip) throw notFound("Truk");
    if (account.kind === "PARTNER" && !mayWrite(account, registration.direction)) throw forbidden();
    if (registration.direction !== "IN") throw invalidState("Slip timbang hanya untuk registrasi incoming.");
    if (account.kind === "PARTNER" && registration.status !== "DRAFT") throw invalidState("Slip timbang hanya bisa diubah selama registrasi masih draf.");
    if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(registration.status)) throw invalidState("Registrasi ini sudah selesai, ditolak, atau dibatalkan.");
    return registration;
  };
  const slipsOf = async (tx: Orm, tripId: number) => (await tripSlipsOf(tx, [tripId])).get(tripId) ?? [];

  app.post("/api/registrations/:id/trips/:tripId/files", slipEditors, async (request, reply) => {
    const { id, tripId } = tripParams.parse(request.params);
    const body = linkBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      const registration = await lockTrip(tx, account, id, tripId);
      const uploader = await uploaderOf(tx, body.fileId);
      // staff files, or files of the supplier whose registration this is
      if (!uploader || (uploader.kind !== "INTERNAL" && uploader.partnerId !== registration.partnerId)) throw unknownFile();
      const [mine] = await tx.select({ n: count() }).from(tripFiles).where(and(eq(tripFiles.tripId, tripId), eq(tripFiles.fileId, body.fileId)));
      if ((mine?.n ?? 0) > 0) throw alreadyUsed();
      if (await linkedAnywhere(tx, body.fileId)) throw invalid("fileId", "Berkas ini sudah dipakai di tempat lain.");
      const [held] = await tx.select({ n: count() }).from(tripFiles).where(and(eq(tripFiles.tripId, tripId), eq(tripFiles.label, SLIP_LABEL)));
      if ((held?.n ?? 0) >= MAX_TRIP_SLIPS) throw refused("TOO_MANY_FILES", `Paling banyak ${MAX_TRIP_SLIPS} slip timbang per truk.`);
      await tx.insert(tripFiles).values({ tripId, fileId: body.fileId, label: SLIP_LABEL, addedBy: account.id, addedAt: now });
      await writeAudit(tx, request, now, { action: "TRIP_SLIP_ADDED", entityType: "registration", entityId: id, before: null, after: { tripId, fileId: body.fileId } });
      return slipsOf(tx, tripId);
    });
    return reply.code(201).send({ files: list });
  });

  app.delete("/api/registrations/:id/trips/:tripId/files/:fileId", slipEditors, async (request) => {
    const { id, tripId, fileId } = tripFileParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const list = await orm.transaction(async (tx) => {
      await lockTrip(tx, account, id, tripId);
      // only a slip: the photos of the field forms stay where they are
      const removed = await tx
        .delete(tripFiles)
        .where(and(eq(tripFiles.tripId, tripId), eq(tripFiles.fileId, fileId), eq(tripFiles.label, SLIP_LABEL)))
        .returning({ fileId: tripFiles.fileId });
      if (removed.length === 0) throw notFound("Slip timbang");
      await writeAudit(tx, request, now, { action: "TRIP_SLIP_REMOVED", entityType: "registration", entityId: id, before: { tripId, fileId }, after: null });
      return slipsOf(tx, tripId);
    });
    return { files: list };
  });
}
