import { and, asc, count, eq, ilike, ne, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { writeAudit } from "../audit.js";
import { accountOf, type Guards } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { partners, vehicles, vehicleTareHistory, vehicleTypes } from "../db/schema.js";
import { duplicate, invalid, invalidState, notFound } from "../errors.js";
import { dateText, idNumber, idParams, lettersAndDigits, likeText, limitParam, searchParam, todayAtPlant } from "../http.js";

const listQuery = z.object({ q: searchParam, limit: limitParam });

const wholeKg = (label: string) => {
  const message = `${label} harus bilangan bulat lebih dari 0.`;
  return z.number(message).int(message).positive(message).max(2_000_000_000, message);
};
const YEAR_MESSAGE = "Tahun pembuatan harus antara 1970 dan 2100.";

const fields = {
  plateDisplay: z.string("Plat nomor wajib diisi.").trim().min(1, "Plat nomor wajib diisi.").max(30, "Plat nomor terlalu panjang."),
  vehicleTypeCode: z.string("Jenis kendaraan wajib diisi.").min(1, "Jenis kendaraan wajib diisi."),
  ownerPartnerId: idNumber.nullable().optional(),
  ownership: z.enum(["SENDIRI", "MITRA"], "Kepemilikan harus SENDIRI atau MITRA.").nullable().optional(),
  capacityKg: wholeKg("Daya angkut").nullable().optional(),
  productionYear: z.number(YEAR_MESSAGE).int(YEAR_MESSAGE).min(1970, YEAR_MESSAGE).max(2100, YEAR_MESSAGE).nullable().optional(),
  // the master tare cannot be cleared: every value it had is kept in vehicle_tare_history
  tareKg: wholeKg("Tarra").optional(),
  tareReason: z.string("Alasan tarra harus berupa teks.").trim().max(500, "Alasan tarra terlalu panjang.").optional(),
  stnkValidUntil: dateText("Masa berlaku STNK").nullable().optional(),
  taxValidUntil: dateText("Masa berlaku pajak").nullable().optional(),
  kirValidUntil: dateText("Masa berlaku KIR").nullable().optional(),
};
const createBody = z.object(fields);
const patchBody = z.object({
  ...fields,
  plateDisplay: fields.plateDisplay.optional(),
  vehicleTypeCode: fields.vehicleTypeCode.optional(),
  isActive: z.boolean("isActive harus true atau false.").optional(),
});

const columns = {
  id: vehicles.id,
  plateNo: vehicles.plateNo,
  plateDisplay: vehicles.plateDisplay,
  vehicleTypeCode: vehicles.vehicleTypeCode,
  ownerId: partners.id,
  ownerName: partners.name,
  ownership: vehicles.ownership,
  capacityKg: vehicles.capacityKg,
  productionYear: vehicles.productionYear,
  tareKg: vehicles.tareKg,
  stnkValidUntil: vehicles.stnkValidUntil,
  taxValidUntil: vehicles.taxValidUntil,
  kirValidUntil: vehicles.kirValidUntil,
  isActive: vehicles.isActive,
  verifiedAt: vehicles.verifiedAt,
  // an active GPS tracker (migration 0011); the table name is written out so the subquery cannot pick vt.id
  hasGps: sql<boolean>`exists (select 1 from vehicle_trackers vt where vt.vehicle_id = vehicles.id and vt.is_active)`.mapWith(Boolean),
};

async function listVehicles(orm: Orm, where: SQL | undefined, limit: number, today: string) {
  const rows = await orm.select(columns).from(vehicles).leftJoin(partners, eq(partners.id, vehicles.ownerPartnerId)).where(where).orderBy(asc(vehicles.plateNo)).limit(limit);
  return rows.map(({ ownerId, ownerName, verifiedAt, ...vehicle }) => {
    const past = (date: string | null) => date !== null && date < today;
    const { isActive, ...rest } = vehicle;
    return {
      ...rest,
      owner: ownerId !== null && ownerName !== null ? { id: ownerId, name: ownerName } : null,
      // which of the three papers are past today
      expired: [past(vehicle.stnkValidUntil) && "STNK", past(vehicle.taxValidUntil) && "TAX", past(vehicle.kirValidUntil) && "KIR"].filter((paper) => paper !== false),
      isActive,
      verified: verifiedAt !== null,
    };
  });
}

/** The stored plate: upper-case letters and digits, as the table's check constraint wants it. */
function plateNoOf(plateDisplay: string): string {
  const plateNo = lettersAndDigits(plateDisplay);
  if (!/^[A-Z0-9]{3,12}$/.test(plateNo)) throw invalid("plateDisplay", "Plat nomor harus 3 sampai 12 huruf atau angka.");
  return plateNo;
}

export function registerVehicleRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const readers = { preHandler: [guards.authenticate, guards.requirePermission("vehicles", "VIEW")] };
  // Staff only: a vehicle entered here is verified at once and may belong to any company. Partner accounts add
  // their vehicles inside a registration.
  const creators = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("vehicles", "CREATE")] };
  const editors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("vehicles", "EDIT")] };

  const one = async (db: Orm, id: number) => {
    const [vehicle] = await listVehicles(db, eq(vehicles.id, id), 1, todayAtPlant(context.now()));
    if (!vehicle) throw notFound("Kendaraan");
    return vehicle;
  };
  /** Checks what the schema cannot: the type exists, the owner is a transporter, the plate is free. */
  async function check(db: Orm, input: { vehicleTypeCode?: string; ownerPartnerId?: number | null; plateNo?: string }, selfId?: number) {
    if (input.vehicleTypeCode !== undefined) {
      const [type] = await db.select({ code: vehicleTypes.code }).from(vehicleTypes).where(eq(vehicleTypes.code, input.vehicleTypeCode));
      if (!type) throw invalid("vehicleTypeCode", `Jenis kendaraan ${input.vehicleTypeCode} tidak ada.`);
    }
    if (input.ownerPartnerId !== undefined && input.ownerPartnerId !== null) {
      const [owner] = await db.select({ isTransporter: partners.isTransporter }).from(partners).where(eq(partners.id, input.ownerPartnerId));
      if (!owner?.isTransporter) throw invalid("ownerPartnerId", "Pemilik harus partner transporter.");
    }
    if (input.plateNo !== undefined) {
      const [taken] = await db
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(and(eq(vehicles.plateNo, input.plateNo), selfId === undefined ? undefined : ne(vehicles.id, selfId)));
      if (taken) throw duplicate(`Plat ${input.plateNo} sudah terdaftar.`);
    }
  }

  app.get("/api/vehicle-types", { preHandler: [guards.authenticate, guards.requireAnyPermission(["vehicles", "VIEW"], ["registrations", "VIEW"])] }, async () => ({ items: await orm.select().from(vehicleTypes).orderBy(asc(vehicleTypes.code)) }));

  app.get("/api/vehicles", readers, async (request) => {
    const query = listQuery.parse(request.query);
    const account = accountOf(request);
    const plate = query.q ? lettersAndDigits(query.q) : "";
    const where = and(
      // a partner account sees the vehicles of its own company
      account.kind === "PARTNER" ? eq(vehicles.ownerPartnerId, account.partner?.id ?? -1) : undefined,
      plate ? ilike(vehicles.plateNo, likeText(plate)) : undefined,
    );
    const [counted] = await orm.select({ total: count() }).from(vehicles).where(where);
    return { items: await listVehicles(orm, where, query.limit, todayAtPlant(context.now())), total: counted?.total ?? 0 };
  });

  app.post("/api/vehicles", creators, async (request, reply) => {
    const { tareReason, ...body } = createBody.parse(request.body);
    const plateNo = plateNoOf(body.plateDisplay);
    const actor = accountOf(request).id;
    const now = context.now();
    const vehicle = await orm.transaction(async (tx) => {
      await check(tx, { ...body, plateNo });
      // entered by staff, so there is nothing left to confirm
      const [created] = await tx
        .insert(vehicles)
        .values({ ...body, plateNo, createdBy: actor, verifiedBy: actor, verifiedAt: now, createdAt: now, updatedAt: now })
        .returning({ id: vehicles.id });
      if (!created) throw new Error("The vehicle was not created.");
      if (body.tareKg !== undefined) {
        await tx.insert(vehicleTareHistory).values({ vehicleId: created.id, tareKg: body.tareKg, source: "MANUAL", reason: tareReason ?? null, changedBy: actor, changedAt: now });
      }
      return one(tx, created.id);
    });
    return reply.code(201).send({ vehicle });
  });

  app.patch("/api/vehicles/:id", editors, async (request) => {
    const { id } = idParams.parse(request.params);
    const { tareReason, ...body } = patchBody.parse(request.body);
    const plateNo = body.plateDisplay === undefined ? undefined : plateNoOf(body.plateDisplay);
    const actor = accountOf(request).id;
    const now = context.now();
    const vehicle = await orm.transaction(async (tx) => {
      const before = await one(tx, id);
      await check(tx, { ...body, plateNo }, id);
      await tx.update(vehicles).set({ ...body, ...(plateNo === undefined ? {} : { plateNo }), updatedAt: now }).where(eq(vehicles.id, id));
      if (body.tareKg !== undefined && body.tareKg !== before.tareKg) {
        await tx.insert(vehicleTareHistory).values({ vehicleId: id, tareKg: body.tareKg, source: "MANUAL", reason: tareReason ?? null, changedBy: actor, changedAt: now });
      }
      return one(tx, id);
    });
    return { vehicle };
  });

  // A vehicle counts as verified while verified_at is set: registrations then raise no VEHICLE_UNVERIFIED finding,
  // and the tare check of an outgoing truck compares against its master tare.
  const setVerified = (verified: boolean) => async (request: FastifyRequest) => {
    const { id } = idParams.parse(request.params);
    const actor = accountOf(request).id;
    const now = context.now();
    const vehicle = await orm.transaction(async (tx) => {
      const [current] = await tx.select({ plateDisplay: vehicles.plateDisplay, verifiedAt: vehicles.verifiedAt }).from(vehicles).where(eq(vehicles.id, id)).for("update");
      if (!current) throw notFound("Kendaraan");
      if ((current.verifiedAt !== null) === verified) {
        throw invalidState(verified ? `Kendaraan ${current.plateDisplay} sudah diverifikasi.` : `Kendaraan ${current.plateDisplay} belum diverifikasi.`);
      }
      await tx
        .update(vehicles)
        .set(verified ? { verifiedBy: actor, verifiedAt: now, updatedAt: now } : { verifiedBy: null, verifiedAt: null, updatedAt: now })
        .where(eq(vehicles.id, id));
      await writeAudit(tx, request, now, {
        action: verified ? "VEHICLE_VERIFIED" : "VEHICLE_UNVERIFIED",
        entityType: "vehicle",
        entityId: id,
        before: { verified: !verified },
        after: { verified },
      });
      return one(tx, id);
    });
    return { vehicle };
  };
  app.post("/api/vehicles/:id/verify", editors, setVerified(true));
  app.post("/api/vehicles/:id/unverify", editors, setVerified(false));
}
