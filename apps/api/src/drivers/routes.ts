import { and, asc, count, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { drivers } from "../db/schema.js";
import { duplicate } from "../errors.js";
import { dateText, lettersAndDigits, likeText, limitParam, searchParam, todayAtPlant } from "../http.js";
import { driverIdByLicence, insertDriver, pushNewDriver } from "./create.js";

const STATUSES = ["NORMAL", "WARNING", "BLACKLIST", "UNKNOWN"] as const;
/** registry_push: NONE (nothing to send), PENDING, SENT, FAILED. */
const PUSH_STATES = ["NONE", "PENDING", "SENT", "FAILED"] as const;
const listQuery = z.object({
  q: searchParam,
  status: z.enum(STATUSES, "Status harus NORMAL, WARNING, BLACKLIST, atau UNKNOWN.").optional(),
  push: z.enum(PUSH_STATES, "Status kirim harus NONE, PENDING, SENT, atau FAILED.").optional(),
  limit: limitParam,
});

const createBody = z.object({
  fullName: z.string("Nama supir wajib diisi.").trim().min(1, "Nama supir wajib diisi.").max(200, "Nama supir terlalu panjang."),
  // stored without spaces or punctuation; the pattern is the table's check constraint
  licenceNo: z
    .string("Nomor SIM wajib diisi.")
    .transform(lettersAndDigits)
    .pipe(z.string().regex(/^[A-Z0-9]{6,20}$/, "Nomor SIM harus 6 sampai 20 huruf atau angka.")),
  licenceClass: z.string("Jenis SIM wajib diisi.").trim().min(1, "Jenis SIM wajib diisi.").max(50, "Jenis SIM terlalu panjang."),
  licenceValidUntil: dateText("Masa berlaku SIM"),
  phone: z.string("Nomor telepon harus berupa teks.").trim().max(30, "Nomor telepon terlalu panjang.").optional(),
});

const columns = {
  id: drivers.id,
  fullName: drivers.fullName,
  licenceNo: drivers.licenceNo,
  licenceClass: drivers.licenceClass,
  licenceValidUntil: drivers.licenceValidUntil,
  registryStatus: drivers.registryStatus,
  registrySyncedAt: drivers.registrySyncedAt,
  registryPush: drivers.registryPush,
  registryPushError: drivers.registryPushError,
  isActive: drivers.isActive,
};
type Row = Pick<typeof drivers.$inferSelect, keyof typeof columns>;

const toItem = (row: Row, today: string) => ({
  id: row.id,
  fullName: row.fullName,
  licenceNo: row.licenceNo,
  licenceClass: row.licenceClass,
  licenceValidUntil: row.licenceValidUntil,
  licenceExpired: row.licenceValidUntil !== null && row.licenceValidUntil < today,
  registryStatus: row.registryStatus,
  registrySyncedAt: row.registrySyncedAt,
  registryPush: row.registryPush,
  registryPushError: row.registryPushError,
  isActive: row.isActive,
});

export function registerDriverRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;

  app.get("/api/drivers", { preHandler: [guards.authenticate, guards.requireStaff] }, async (request) => {
    const query = listQuery.parse(request.query);
    const conditions: (SQL | undefined)[] = [];
    if (query.status) conditions.push(eq(drivers.registryStatus, query.status));
    if (query.push) conditions.push(eq(drivers.registryPush, query.push));
    if (query.q) {
      const licence = lettersAndDigits(query.q);
      conditions.push(or(ilike(drivers.fullName, likeText(query.q)), licence ? ilike(drivers.licenceNo, likeText(licence)) : undefined));
    }
    const where = and(...conditions);
    const [counted] = await orm.select({ total: count() }).from(drivers).where(where);
    const rows = await orm.select(columns).from(drivers).where(where).orderBy(asc(sql`lower(${drivers.fullName})`), asc(drivers.id)).limit(query.limit);
    const today = todayAtPlant(context.now());
    return { items: rows.map((row) => toItem(row, today)), total: counted?.total ?? 0 };
  });

  // A driver entered here is not in the central registry yet: status UNKNOWN, queued to be sent there.
  // With a registry account it is sent at once, within a few seconds; whatever happens there, the driver is
  // created here, and one that was not sent waits for the next sync run.
  const writers = { preHandler: [guards.authenticate, guards.requireRole("SUPER_ADMIN", "LOGISTICS_ADMIN", "REGISTRATION_OPERATOR")] };
  app.post("/api/drivers", writers, async (request, reply) => {
    const body = createBody.parse(request.body);
    if ((await driverIdByLicence(orm, body.licenceNo)) !== null) throw duplicate(`Nomor SIM ${body.licenceNo} sudah terdaftar.`);
    const now = context.now();
    const id = await insertDriver(orm, body, accountOf(request).id, now);
    const pushStopped = await pushNewDriver(context, id, request.log);
    const [current] = await orm.select(columns).from(drivers).where(eq(drivers.id, id));
    if (!current) throw new Error("The driver was not created.");
    return reply.code(201).send({ driver: toItem(current, todayAtPlant(now)), ...(pushStopped ? { pushStopped } : {}) });
  });
}
