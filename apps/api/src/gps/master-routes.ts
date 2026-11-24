// Masters of the GPS intake (staff with gps EDIT): sources and their keys, trackers that attach a device id of a
// source to a vehicle, and the device ids a source sent that no tracker knows yet.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { GPS_SOURCE_KINDS, gpsSources, gpsUnknownDevices, vehicles, vehicleTrackers } from "../db/schema.js";
import { duplicate, invalid, invalidState, notFound, violatedUnique } from "../errors.js";
import { idNumber, idParams } from "../http.js";
import { generateTrackerKey } from "./keys.js";

const sourceBody = z.object({
  name: z.string("Nama wajib diisi.").trim().min(1, "Nama wajib diisi.").max(100, "Nama terlalu panjang."),
  kind: z.enum(GPS_SOURCE_KINDS, "Jenis harus PROVIDER (penyedia, banyak alat) atau DEVICE (satu alat)."),
});
const trackerBody = z.object({
  vehicleId: idNumber,
  sourceId: idNumber,
  deviceId: z.string("Nomor alat wajib diisi.").trim().min(1, "Nomor alat wajib diisi.").max(64, "Nomor alat terlalu panjang."),
});
const trackerQuery = z.object({ sourceId: idNumber.optional(), vehicleId: idNumber.optional() });

type SourceRow = typeof gpsSources.$inferSelect;

const sourceView = (row: SourceRow, trackers: number) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  isActive: row.isActive,
  hasKey: row.keyHash !== null,
  keyCreatedAt: row.keyCreatedAt,
  lastSeenAt: row.lastSeenAt,
  trackers,
});

// the outer column is written out: Drizzle may render it without its table, and then it would name vt.id
const activeTrackers = sql<number>`(select count(*)::int from vehicle_trackers vt where vt.source_id = gps_sources.id and vt.is_active)`.mapWith(Number);

async function loadSource(orm: Orm, id: number) {
  const [row] = await orm.select({ source: gpsSources, trackers: activeTrackers }).from(gpsSources).where(eq(gpsSources.id, id));
  if (!row) throw notFound("Sumber GPS");
  return sourceView(row.source, row.trackers);
}

async function loadTrackers(orm: Orm, where: ReturnType<typeof and>) {
  const rows = await orm
    .select({ tracker: vehicleTrackers, plateDisplay: vehicles.plateDisplay, sourceName: gpsSources.name })
    .from(vehicleTrackers)
    .innerJoin(vehicles, eq(vehicles.id, vehicleTrackers.vehicleId))
    .innerJoin(gpsSources, eq(gpsSources.id, vehicleTrackers.sourceId))
    .where(where)
    .orderBy(desc(vehicleTrackers.isActive), asc(vehicles.plateNo), desc(vehicleTrackers.attachedAt));
  return rows.map(({ tracker: t, plateDisplay, sourceName }) => ({
    id: t.id,
    vehicle: { id: t.vehicleId, plateDisplay },
    source: { id: t.sourceId, name: sourceName },
    deviceId: t.deviceId,
    isActive: t.isActive,
    attachedAt: t.attachedAt,
    detachedAt: t.detachedAt,
  }));
}

export function registerGpsMasterRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const editors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("gps", "EDIT")] };

  app.get("/api/gps/sources", editors, async () => {
    const rows = await orm.select({ source: gpsSources, trackers: activeTrackers }).from(gpsSources).orderBy(desc(gpsSources.isActive), asc(gpsSources.name));
    return { items: rows.map((row) => sourceView(row.source, row.trackers)) };
  });

  app.post("/api/gps/sources", editors, async (request, reply) => {
    const body = sourceBody.parse(request.body ?? {});
    const actor = accountOf(request).id;
    const now = context.now();
    const created = await orm.transaction(async (tx) => {
      const [row] = await tx.insert(gpsSources).values({ name: body.name, kind: body.kind, createdBy: actor, createdAt: now }).returning({ id: gpsSources.id });
      if (!row) throw new Error("The GPS source was not created.");
      const { key, hash } = generateTrackerKey(row.id);
      await tx.update(gpsSources).set({ keyHash: hash, keyCreatedAt: now }).where(eq(gpsSources.id, row.id));
      const source = await loadSource(tx, row.id);
      await writeAudit(tx, request, now, { action: "GPS_SOURCE_CREATED", entityType: "gps_source", entityId: row.id, before: null, after: source });
      return { source, key };
    });
    return reply.code(201).send(created);
  });

  app.post("/api/gps/sources/:id/key", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const now = context.now();
    const before = await loadSource(orm, id);
    const { key, hash } = generateTrackerKey(id);
    const source = await orm.transaction(async (tx) => {
      await tx.update(gpsSources).set({ keyHash: hash, keyCreatedAt: now }).where(eq(gpsSources.id, id));
      await writeAudit(tx, request, now, { action: "GPS_SOURCE_KEY_CREATED", entityType: "gps_source", entityId: id, before: { keyCreatedAt: before.keyCreatedAt }, after: { keyCreatedAt: now } });
      return loadSource(tx, id);
    });
    return { source, key };
  });

  app.post("/api/gps/sources/:id/deactivate", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const now = context.now();
    const before = await loadSource(orm, id);
    if (!before.isActive) throw invalidState("Sumber GPS ini sudah tidak aktif.");
    const source = await orm.transaction(async (tx) => {
      await tx.update(gpsSources).set({ isActive: false }).where(eq(gpsSources.id, id));
      await writeAudit(tx, request, now, { action: "GPS_SOURCE_DEACTIVATED", entityType: "gps_source", entityId: id, before: { isActive: true }, after: { isActive: false } });
      return loadSource(tx, id);
    });
    return { source };
  });

  app.get("/api/gps/sources/:id/unknown-devices", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadSource(orm, id);
    const rows = await orm.select().from(gpsUnknownDevices).where(eq(gpsUnknownDevices.sourceId, id)).orderBy(asc(gpsUnknownDevices.deviceId));
    return {
      items: rows.map((row) => ({ deviceId: row.deviceId, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, lastPointAt: row.lastPointAt, pointCount: row.pointCount })),
    };
  });

  app.get("/api/gps/trackers", editors, async (request) => {
    const query = trackerQuery.parse(request.query);
    return {
      items: await loadTrackers(
        orm,
        and(query.sourceId ? eq(vehicleTrackers.sourceId, query.sourceId) : undefined, query.vehicleId ? eq(vehicleTrackers.vehicleId, query.vehicleId) : undefined),
      ),
    };
  });

  app.post("/api/gps/trackers", editors, async (request, reply) => {
    const body = trackerBody.parse(request.body ?? {});
    const actor = accountOf(request).id;
    const now = context.now();
    const [vehicle] = await orm.select({ plateDisplay: vehicles.plateDisplay }).from(vehicles).where(eq(vehicles.id, body.vehicleId));
    if (!vehicle) throw invalid("vehicleId", "Kendaraan tidak ditemukan.");
    const [source] = await orm.select({ isActive: gpsSources.isActive }).from(gpsSources).where(eq(gpsSources.id, body.sourceId));
    if (!source) throw invalid("sourceId", "Sumber GPS tidak ditemukan.");
    if (!source.isActive) throw invalid("sourceId", "Sumber GPS ini sudah tidak aktif.");
    const busyVehicle = () => duplicate(`Kendaraan ${vehicle.plateDisplay} sudah memakai alat pelacak lain.`);
    try {
      const tracker = await orm.transaction(async (tx) => {
        const [taken] = await tx.select({ id: vehicleTrackers.id }).from(vehicleTrackers).where(and(eq(vehicleTrackers.vehicleId, body.vehicleId), eq(vehicleTrackers.isActive, true)));
        if (taken) throw busyVehicle();
        const [used] = await tx
          .select({ plateDisplay: vehicles.plateDisplay })
          .from(vehicleTrackers)
          .innerJoin(vehicles, eq(vehicles.id, vehicleTrackers.vehicleId))
          .where(and(eq(vehicleTrackers.sourceId, body.sourceId), eq(vehicleTrackers.deviceId, body.deviceId), eq(vehicleTrackers.isActive, true)));
        if (used) throw duplicate(`Alat ${body.deviceId} sudah terpasang di kendaraan ${used.plateDisplay}.`);
        const [row] = await tx
          .insert(vehicleTrackers)
          .values({ vehicleId: body.vehicleId, sourceId: body.sourceId, deviceId: body.deviceId, attachedBy: actor, attachedAt: now })
          .returning({ id: vehicleTrackers.id });
        if (!row) throw new Error("The tracker was not created.");
        // the device is known now
        await tx.delete(gpsUnknownDevices).where(and(eq(gpsUnknownDevices.sourceId, body.sourceId), eq(gpsUnknownDevices.deviceId, body.deviceId)));
        const [shown] = await loadTrackers(tx, and(eq(vehicleTrackers.id, row.id)));
        await writeAudit(tx, request, now, { action: "GPS_TRACKER_ATTACHED", entityType: "vehicle_tracker", entityId: row.id, before: null, after: shown });
        return shown;
      });
      return reply.code(201).send({ tracker });
    } catch (error) {
      // two attachments at the same moment: the unique indexes decide
      const constraint = violatedUnique(error);
      if (constraint === "vehicle_trackers_vehicle_key") throw busyVehicle();
      if (constraint === "vehicle_trackers_device_key") throw duplicate(`Alat ${body.deviceId} sudah terpasang di kendaraan lain.`);
      throw error;
    }
  });

  app.post("/api/gps/trackers/:id/detach", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const actor = accountOf(request).id;
    const now = context.now();
    const tracker = await orm.transaction(async (tx) => {
      const [current] = await tx.select().from(vehicleTrackers).where(eq(vehicleTrackers.id, id)).for("update");
      if (!current) throw notFound("Alat pelacak");
      if (!current.isActive) throw invalidState("Alat pelacak ini sudah dilepas.");
      await tx.update(vehicleTrackers).set({ isActive: false, detachedBy: actor, detachedAt: now }).where(eq(vehicleTrackers.id, id));
      await writeAudit(tx, request, now, { action: "GPS_TRACKER_DETACHED", entityType: "vehicle_tracker", entityId: id, before: { isActive: true }, after: { isActive: false } });
      const [shown] = await loadTrackers(tx, and(eq(vehicleTrackers.id, id)));
      return shown;
    });
    return { tracker };
  });
}
