import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { partners, registrations } from "../db/schema.js";
import { pushNewDriver } from "../drivers/create.js";
import { forbidden, invalid, invalidState, notFound } from "../errors.js";
import { idParams, lettersAndDigits, likeText, limitParam, searchParam } from "../http.js";
import { expireDueTrips } from "../trips/view.js";
import {
  approve,
  cancelTrips,
  hasArrived,
  mayWrite,
  REVIEWERS,
  registrationBody,
  storeFindings,
  submitRegistration,
  writeRegistration,
} from "./service.js";
import { loadRegistrations, registrationsVisibleTo } from "./view.js";

const STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "CLOSED"] as const;
const listQuery = z.object({
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT.").optional(),
  status: z.enum(STATUSES, "Status registrasi tidak dikenal.").optional(),
  q: searchParam,
  limit: limitParam,
});
const noteBody = z.object({ note: z.string("Catatan harus berupa teks.").trim().max(1000, "Catatan terlalu panjang.").optional() });
const requiredNote = z.object({ note: z.string("Alasan penolakan wajib diisi.").trim().min(1, "Alasan penolakan wajib diisi.").max(1000, "Catatan terlalu panjang.") });
const reasonBody = z.object({ reason: z.string("Alasan wajib diisi.").trim().min(1, "Alasan wajib diisi.").max(500, "Alasan terlalu panjang.") });

export function registerRegistrationRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const signedIn = { preHandler: [guards.authenticate, guards.requireRole()] };
  const reviewers = { preHandler: [guards.authenticate, guards.requireRole(...REVIEWERS)] };

  const one = async (db: Orm, id: number) => {
    const [registration] = await loadRegistrations(db, [id]);
    if (!registration) throw notFound("Registrasi");
    return registration;
  };
  /** Locks the registration; 404 when the account may not see it. */
  const lock = async (db: Orm, id: number, account: Account) => {
    const [row] = await db.select().from(registrations).where(and(eq(registrations.id, id), registrationsVisibleTo(account))).for("update");
    if (!row) throw notFound("Registrasi");
    return row;
  };
  const audit = (db: Orm, request: FastifyRequest, now: Date, id: number, action: string, after: unknown, reason?: string) =>
    writeAudit(db, request, now, { action, entityType: "registration", entityId: id, before: null, after, ...(reason ? { reason } : {}) });
  /** Sends the drivers entered in place to the registry, after the registration is committed. */
  const pushDrivers = async (request: FastifyRequest, ids: number[]) => {
    for (const id of ids) await pushNewDriver(context, id, request.log);
  };

  app.get("/api/registrations", signedIn, async (request) => {
    const query = listQuery.parse(request.query);
    const account = accountOf(request);
    await expireDueTrips(orm, context.now());
    const pattern = query.q ? likeText(query.q) : null;
    const plate = query.q ? lettersAndDigits(query.q) : "";
    const where = and(
      registrationsVisibleTo(account),
      query.direction ? eq(registrations.direction, query.direction) : undefined,
      query.status ? eq(registrations.status, query.status) : undefined,
      pattern
        ? or(
            ilike(registrations.regNo, pattern),
            ilike(partners.name, pattern),
            sql`exists (select 1 from registration_allocations ra where ra.registration_id = ${registrations.id} and (ra.contract_no ilike ${pattern} or ra.do_no ilike ${pattern}))`,
            plate
              ? sql`exists (select 1 from trips t join vehicles v on v.id = t.vehicle_id where t.registration_id = ${registrations.id} and v.plate_no like ${likeText(plate)})`
              : undefined,
          )
        : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(registrations).innerJoin(partners, eq(partners.id, registrations.partnerId)).where(where);
    const ids = await orm
      .select({ id: registrations.id })
      .from(registrations)
      .innerJoin(partners, eq(partners.id, registrations.partnerId))
      .where(where)
      .orderBy(desc(registrations.createdAt), desc(registrations.id))
      .limit(query.limit);
    return { items: await loadRegistrations(orm, ids.map((row) => row.id), false), total: counted?.total ?? 0 };
  });

  app.get("/api/registrations/:id", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    await expireDueTrips(orm, context.now());
    const [visible] = await orm.select({ id: registrations.id }).from(registrations).where(and(eq(registrations.id, id), registrationsVisibleTo(accountOf(request))));
    if (!visible) throw notFound("Registrasi");
    return { registration: await one(orm, id) };
  });

  app.post("/api/registrations", signedIn, async (request, reply) => {
    const body = registrationBody.parse(request.body);
    const account = accountOf(request);
    if (!mayWrite(account, body.direction)) throw forbidden();
    const now = context.now();
    const { registration, newDrivers } = await orm.transaction(async (tx) => {
      const written = await writeRegistration(tx, account, body, now);
      if (body.submit) await submitRegistration(tx, written.id, account.id, now);
      else await storeFindings(tx, written.id, now);
      return { registration: await one(tx, written.id), newDrivers: written.newDrivers };
    });
    await pushDrivers(request, newDrivers);
    return reply.code(201).send({ registration: newDrivers.length ? await one(orm, registration.id) : registration });
  });

  app.put("/api/registrations/:id", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = registrationBody.parse(request.body);
    const account = accountOf(request);
    if (!mayWrite(account, body.direction)) throw forbidden();
    const now = context.now();
    const newDrivers = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "DRAFT") throw invalidState("Hanya registrasi berstatus DRAFT yang bisa diubah.");
      if (current.direction !== body.direction) throw invalid("direction", "Arah registrasi tidak bisa diubah.");
      const written = await writeRegistration(tx, account, body, now, current);
      if (body.submit) await submitRegistration(tx, id, account.id, now);
      else await storeFindings(tx, id, now);
      return written.newDrivers;
    });
    await pushDrivers(request, newDrivers);
    return { registration: await one(orm, id) };
  });

  app.post("/api/registrations/:id/submit", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const registration = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (!mayWrite(account, current.direction)) throw forbidden();
      await submitRegistration(tx, id, account.id, now);
      return one(tx, id);
    });
    return { registration };
  });

  app.post("/api/registrations/:id/approve", reviewers, async (request) => {
    const { id } = idParams.parse(request.params);
    const { note } = noteBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const registration = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "SUBMITTED") throw invalidState("Hanya registrasi yang menunggu tinjauan yang bisa disetujui.");
      await approve(tx, id, account.id, now, { note: note ?? null });
      await audit(tx, request, now, id, "REGISTRATION_APPROVED", { status: "APPROVED" }, note);
      return one(tx, id);
    });
    return { registration };
  });

  app.post("/api/registrations/:id/reject", reviewers, async (request) => {
    const { id } = idParams.parse(request.params);
    const { note } = requiredNote.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const registration = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      if (current.status !== "SUBMITTED") throw invalidState("Hanya registrasi yang menunggu tinjauan yang bisa ditolak.");
      await tx.update(registrations).set({ status: "REJECTED", reviewedBy: account.id, reviewedAt: now, reviewNote: note, updatedAt: now }).where(eq(registrations.id, id));
      await cancelTrips(tx, id, account.id, now, note);
      await audit(tx, request, now, id, "REGISTRATION_REJECTED", { status: "REJECTED" }, note);
      return one(tx, id);
    });
    return { registration };
  });

  app.post("/api/registrations/:id/cancel", signedIn, async (request) => {
    const { id } = idParams.parse(request.params);
    const account = accountOf(request);
    const now = context.now();
    const registration = await orm.transaction(async (tx) => {
      const current = await lock(tx, id, account);
      // a partner account reaches here only for its own registrations; staff need to be the creator or an admin
      if (account.kind === "INTERNAL" && current.createdBy !== account.id && !account.roles.some((role) => REVIEWERS.includes(role))) throw forbidden();
      const { reason } = reasonBody.parse(request.body ?? {});
      if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(current.status)) throw invalidState("Registrasi ini sudah selesai, ditolak, atau dibatalkan.");
      if (await hasArrived(tx, id)) throw invalidState("Registrasi tidak bisa dibatalkan: sudah ada truk yang check-in.");
      await cancelTrips(tx, id, account.id, now, reason);
      await tx.update(registrations).set({ status: "CANCELLED", updatedAt: now }).where(eq(registrations.id, id));
      await audit(tx, request, now, id, "REGISTRATION_CANCELLED", { status: "CANCELLED" }, reason);
      return one(tx, id);
    });
    return { registration };
  });
}
