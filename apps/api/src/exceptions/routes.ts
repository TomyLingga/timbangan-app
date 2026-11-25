// Requests for a decision (exceptions) for the holders of `approvals`: list, detail, decide, report data.
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { cardAssignments, EXCEPTION_STATUSES, EXCEPTION_TYPES, exceptions, partners, registrations, sites, stations, trips, users, vehicles, weighings } from "../db/schema.js";
import { notFound, refused } from "../errors.js";
import { idParams, limitParam } from "../http.js";
import { loadAllocations } from "../weighing/view.js";
import { decideBody, decideException, reportTitle } from "./decide.js";
import { contextOf, expireStaleExceptions, loadExceptionViews, visibleTypes } from "./service.js";

const listFilter = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z
    .string(message)
    .transform((text) => text.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(z.enum(values, message)))
    .optional();
const listQuery = z.object({
  status: listFilter(EXCEPTION_STATUSES, `Status harus salah satu dari ${EXCEPTION_STATUSES.join(", ")}; beberapa dipisah koma.`),
  type: listFilter(EXCEPTION_TYPES, `Jenis harus salah satu dari ${EXCEPTION_TYPES.join(", ")}; beberapa dipisah koma.`),
  limit: limitParam,
});

const transporterOf = alias(partners, "report_transporter");
const decider = alias(users, "report_decider");

export function registerExceptionRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  // weighbridge requests are for the holders of approvals, QC holds for the holders of qc_approvals
  const viewers = { preHandler: [guards.authenticate, guards.requireInternal, guards.requireAnyPermission(["approvals", "VIEW"], ["qc_approvals", "VIEW"])] };
  const deciders = { preHandler: [guards.authenticate, guards.requireInternal, guards.requireAnyPermission(["approvals", "EDIT"], ["qc_approvals", "EDIT"])] };
  const reporters = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("approvals", "VIEW")] };

  /** One request of a type the account may see; 404 otherwise. */
  const one = async (id: number, request: FastifyRequest) => {
    const [view] = await loadExceptionViews(orm, eq(exceptions.id, id), 1);
    if (!view || !visibleTypes(accountOf(request)).includes(view.type)) throw notFound("Permintaan");
    return view;
  };

  app.get("/api/exceptions", viewers, async (request) => {
    const query = listQuery.parse(request.query);
    await expireStaleExceptions(orm, context.now());
    const conditions: (SQL | undefined)[] = [
      query.status?.length ? inArray(exceptions.status, query.status) : undefined,
      query.type?.length ? inArray(exceptions.type, query.type) : undefined,
      inArray(exceptions.type, visibleTypes(accountOf(request))),
    ];
    return { items: await loadExceptionViews(orm, and(...conditions), query.limit) };
  });

  app.get("/api/exceptions/:id", viewers, async (request) => {
    const { id } = idParams.parse(request.params);
    await expireStaleExceptions(orm, context.now());
    return { exception: await one(id, request) };
  });

  app.post("/api/exceptions/:id/decide", deciders, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = decideBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const result = await orm.transaction((tx) => decideException(tx, request, account, id, body, now));
    return { exception: await one(result.exceptionId, request), weighing: result.weighing, next: result.next };
  });

  // the data of the Berita Acara of an approved weight difference
  app.get("/api/exceptions/:id/report", reporters, async (request) => {
    const { id } = idParams.parse(request.params);
    const [row] = await orm
      .select({
        exception: exceptions,
        siteCode: sites.code,
        siteName: sites.name,
        tripNo: trips.tripNo,
        plateNo: trips.plateNo,
        plateDisplay: vehicles.plateDisplay,
        driverName: trips.driverName,
        direction: registrations.direction,
        partnerName: partners.name,
        transporterName: transporterOf.name,
        stationCode: stations.code,
        stationName: stations.name,
        deciderName: decider.fullName,
        weighedAt: weighings.weighedAt,
        weighingKg: weighings.weightKg,
      })
      .from(exceptions)
      .innerJoin(sites, eq(sites.id, exceptions.siteId))
      .innerJoin(trips, eq(trips.id, exceptions.tripId))
      .innerJoin(registrations, eq(registrations.id, trips.registrationId))
      .innerJoin(partners, eq(partners.id, registrations.partnerId))
      .leftJoin(transporterOf, eq(transporterOf.id, trips.transporterId))
      .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
      .leftJoin(stations, eq(stations.id, exceptions.stationId))
      .leftJoin(decider, eq(decider.id, exceptions.decidedBy))
      .leftJoin(weighings, eq(weighings.id, exceptions.weighingId))
      .where(eq(exceptions.id, id));
    if (!row) throw notFound("Permintaan");
    const { exception } = row;
    if (!exception.reportNo) throw refused("NO_REPORT", "Permintaan ini tidak punya Berita Acara.");
    const lines = await loadAllocations(orm, exception.tripId);
    // signed by the operator of the post who checked the truck in, and by the approver (owner, 25 November 2026)
    const [registrar] = await orm
      .select({ id: users.id, fullName: users.fullName })
      .from(cardAssignments)
      .innerJoin(users, eq(users.id, cardAssignments.assignedBy))
      .where(eq(cardAssignments.tripId, exception.tripId))
      .orderBy(asc(cardAssignments.assignedAt))
      .limit(1);
    const stored = contextOf(exception);
    return {
      report: {
        reportNo: exception.reportNo,
        title: reportTitle(exception),
        type: exception.type,
        exceptionId: exception.id,
        site: { code: row.siteCode, name: row.siteName },
        trip: {
          id: exception.tripId, tripNo: row.tripNo, plateNo: row.plateNo, plateDisplay: row.plateDisplay, driverName: row.driverName,
          direction: row.direction, partner: row.partnerName, transporter: row.transporterName,
        },
        lines: lines.map((line) => ({ seq: line.seq, contractNo: line.contractNo, doNo: line.doNo })),
        station: { code: row.stationCode, name: row.stationName },
        expectedKg: exception.expectedValue,
        weighedKg: exception.actualValue,
        diffKg: exception.diffValue,
        diffPct: exception.diffPct,
        tolerancePct: exception.tolerancePct,
        weighing: exception.weighingId === null ? null : { id: exception.weighingId, weightKg: row.weighingKg, weighedAt: row.weighedAt },
        reason: exception.decisionReason,
        raisedAt: exception.raisedAt,
        decidedAt: exception.decidedAt,
        decidedBy: exception.decidedBy === null ? null : { id: exception.decidedBy, fullName: row.deciderName },
        masterTareUpdated: stored.masterTareUpdated === true,
        plate: exception.type === "PLATE" ? { read: stored.plateRead ?? null, registered: stored.plateDisplay ?? row.plateDisplay ?? row.plateNo } : null,
        signers: [
          { role: "REGISTRAR", title: "Dibuat oleh", position: "Operator registrasi", user: registrar ?? null },
          { role: "APPROVER", title: "Disetujui oleh", position: "Penyetuju", user: exception.decidedBy === null ? null : { id: exception.decidedBy, fullName: row.deciderName } },
        ],
      },
    };
  });
}
