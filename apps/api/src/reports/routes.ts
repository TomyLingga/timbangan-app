// Reports for the holders of `reports`: realisation per contract, and one line per truck allocation. Both
// answer a page of JSON with the number of matching lines and totals over all of them, or every matching line
// as CSV with `?format=csv`.
import { and, asc, count, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { deliveryOrders, erpContracts, partners, products, registrationAllocations, registrations, tripAllocations, trips, vehicles, weighings } from "../db/schema.js";
import { invalid } from "../errors.js";
import { dateText, lettersAndDigits, likeText, PLANT_TIME_ZONE, searchParam } from "../http.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const LIMIT_MESSAGE = "Limit harus angka mulai dari 1.";
const OFFSET_MESSAGE = "Offset harus angka mulai dari 0.";
const page = {
  /** 50 when absent, never more than 200. */
  limit: z.coerce
    .number(LIMIT_MESSAGE)
    .int(LIMIT_MESSAGE)
    .min(1, LIMIT_MESSAGE)
    .default(PAGE_SIZE)
    .transform((value) => Math.min(value, MAX_PAGE_SIZE)),
  offset: z.coerce.number(OFFSET_MESSAGE).int(OFFSET_MESSAGE).min(0, OFFSET_MESSAGE).default(0),
};
const period = {
  from: dateText("Tanggal awal").optional(),
  to: dateText("Tanggal akhir").optional(),
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT.").optional(),
  format: z.enum(["json", "csv"], "Format harus json atau csv.").default("json"),
};
const contractsQuery = z.object({
  ...period,
  ...page,
  q: searchParam,
  // moving: realised in the period, or trucks of it inside the plant now; all: every contract line
  activity: z.enum(["moving", "all"], "Activity harus moving atau all.").default("moving"),
});
const tripsQuery = z.object({ ...period, ...page, q: searchParam });

function checkPeriod(query: { from?: string; to?: string }): void {
  if (query.from && query.to && query.from > query.to) throw invalid("to", "Tanggal akhir tidak boleh sebelum tanggal awal.");
}

/** The plant date of a timestamp column is within the period (either end may be open). */
function inPeriod(column: SQL, query: { from?: string; to?: string }): SQL | undefined {
  const day = sql`(${column} at time zone ${PLANT_TIME_ZONE})::date`;
  return and(query.from ? sql`${day} >= ${query.from}` : undefined, query.to ? sql`${day} <= ${query.to}` : undefined);
}

const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString();
  return `"${String(value).replaceAll('"', '""')}"`;
};

/** CSV with a byte order mark (so spreadsheet programs read it as UTF-8), comma separated, CRLF lines. */
function sendCsv(reply: FastifyReply, fileName: string, header: string[], rows: unknown[][]) {
  const text = [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${fileName}"`)
    .send(`﻿${text}\r\n`);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** A numeric sum from the database (text, or null over no rows) as a number. */
const amount = (value: string | number | null | undefined) => round3(Number(value ?? 0));

/** The trucks the reports count: inside the plant or done. */
const COUNTED_STATUSES = ["COMPLETED", "CHECKED_IN", "IN_PROCESS"] as const;

export function registerReportRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const readers = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("reports", "VIEW")] };

  app.get("/api/reports/contracts", readers, async (request, reply) => {
    const query = contractsQuery.parse(request.query);
    checkPeriod(query);

    // every allocation of a truck to a contract, directly (incoming) or through its DO (outgoing)
    const lineContract = sql`coalesce(${registrationAllocations.contractId}, ${deliveryOrders.contractId})`;
    const completed = sql`${trips.status} = 'COMPLETED'`;
    const completedInPeriod = query.from || query.to ? sql`${completed} and coalesce(${inPeriod(sql`${trips.completedAt}`, query)}, false)` : completed;
    const qty = sql`coalesce(${tripAllocations.qtyActual}, ${tripAllocations.netKg})`;
    const toTrip = eq(trips.id, tripAllocations.tripId);
    const toAllocation = eq(registrationAllocations.id, tripAllocations.registrationAllocationId);
    const toOrder = eq(deliveryOrders.id, registrationAllocations.deliveryOrderId);
    const movement = orm
      .select({
      contractId: sql<number>`${lineContract}`.as("contract_id"),
      realised: sql<string | null>`sum(${qty}) filter (where ${completedInPeriod})`.as("realised"),
      realisedTotal: sql<string | null>`sum(${qty}) filter (where ${completed})`.as("realised_total"),
      inProgress: sql<string | null>`sum(${tripAllocations.qtyPlanned}) filter (where not ${completed})`.as("in_progress"),
      trucksInside: sql<number>`count(distinct ${trips.id}) filter (where not ${completed})`.as("trucks_inside"),
      tripCount: sql<number>`count(distinct ${trips.id}) filter (where ${completedInPeriod})`.as("trip_count"),
      })
      .from(tripAllocations)
      .innerJoin(trips, toTrip)
      .innerJoin(registrationAllocations, toAllocation)
      .leftJoin(deliveryOrders, toOrder)
      .where(inArray(trips.status, [...COUNTED_STATUSES]))
      .groupBy(lineContract)
      .as("movement");

    const where = and(
      query.direction ? eq(erpContracts.direction, query.direction) : undefined,
      query.q ? or(ilike(erpContracts.contractNo, likeText(query.q)), ilike(partners.name, likeText(query.q))) : undefined,
      query.activity === "moving" ? or(sql`coalesce(${movement.realised}, 0) > 0`, sql`coalesce(${movement.trucksInside}, 0) > 0`) : undefined,
    );
    const toPartner = eq(partners.id, erpContracts.partnerId);
    const toProduct = eq(products.id, erpContracts.productId);
    const toMovement = eq(movement.contractId, erpContracts.id);

    const listed = orm
      .select({
      id: erpContracts.id,
      contractNo: erpContracts.contractNo,
      direction: erpContracts.direction,
      partnerName: partners.name,
      productName: products.name,
      uom: erpContracts.uom,
      qtyContract: erpContracts.qtyContract,
      qtyOpening: erpContracts.qtyOpening,
      state: erpContracts.state,
      realised: movement.realised,
      realisedTotal: movement.realisedTotal,
      inProgress: movement.inProgress,
      tripCount: movement.tripCount,
      })
      .from(erpContracts)
      .innerJoin(partners, toPartner)
      .innerJoin(products, toProduct)
      .leftJoin(movement, toMovement)
      .where(where)
      .orderBy(asc(erpContracts.contractNo), asc(erpContracts.id));
    const rows = query.format === "csv" ? await listed : await listed.limit(query.limit).offset(query.offset);

    const items = rows.map((row) => {
      const realisedTotal = amount(row.realisedTotal);
      return {
        contractId: row.id,
        contractNo: row.contractNo,
        direction: row.direction,
        partner: row.partnerName,
        product: row.productName,
        uom: row.uom,
        state: row.state,
        qtyContract: row.qtyContract,
        qtyOpening: row.qtyOpening,
        realised: amount(row.realised),
        realisedTotal,
        inProgress: amount(row.inProgress),
        remaining: row.qtyContract === null ? null : round3(row.qtyContract - row.qtyOpening - realisedTotal),
        tripCount: Number(row.tripCount ?? 0),
      };
    });
    if (query.format === "csv") {
      return sendCsv(
        reply,
        "realisasi-kontrak.csv",
        ["Nomor kontrak", "Arah", "Partner", "Produk", "Satuan", "Kuantitas kontrak", "Pembukaan", "Realisasi periode", "Realisasi total", "Sedang berjalan", "Sisa", "Jumlah truk"],
        items.map((row) => [row.contractNo, row.direction, row.partner, row.product, row.uom, row.qtyContract, row.qtyOpening, row.realised, row.realisedTotal, row.inProgress, row.remaining, row.tripCount]),
      );
    }

    const perUom = await orm
      .select({ uom: erpContracts.uom, lines: count(), realised: sql<string | null>`sum(${movement.realised})` })
      .from(erpContracts)
      .innerJoin(partners, toPartner)
      .innerJoin(products, toProduct)
      .leftJoin(movement, toMovement)
      .where(where)
      .groupBy(erpContracts.uom)
      .orderBy(asc(erpContracts.uom));
    // a truck with two contracts of the set is one truck
    const inSet = orm.select({ id: erpContracts.id }).from(erpContracts).innerJoin(partners, toPartner).innerJoin(products, toProduct).leftJoin(movement, toMovement).where(where);
    const [trucks] = await orm
      .select({ n: sql<number>`count(distinct ${trips.id})`.mapWith(Number) })
      .from(tripAllocations)
      .innerJoin(trips, toTrip)
      .innerJoin(registrationAllocations, toAllocation)
      .leftJoin(deliveryOrders, toOrder)
      .where(and(completedInPeriod, inArray(lineContract, inSet)));
    const realisedByUom = perUom.filter((row) => amount(row.realised) !== 0).map((row) => ({ uom: row.uom, realised: amount(row.realised) }));
    return {
      items,
      total: perUom.reduce((sum, row) => sum + Number(row.lines), 0),
      limit: query.limit,
      offset: query.offset,
      totals: {
        // a plain sum; realisedByUom keeps quantities of different units apart
        realised: round3(perUom.reduce((sum, row) => sum + amount(row.realised), 0)),
        realisedByUom,
        tripCount: trucks?.n ?? 0,
      },
    };
  });

  app.get("/api/reports/trips", readers, async (request, reply) => {
    const query = tripsQuery.parse(request.query);
    checkPeriod(query);
    const first = alias(weighings, "report_weigh_1");
    const second = alias(weighings, "report_weigh_2");
    const plate = query.q ? lettersAndDigits(query.q) : "";
    const pattern = query.q ? likeText(query.q) : null;
    const where = and(
      query.direction ? eq(registrations.direction, query.direction) : undefined,
      inPeriod(sql`${first.weighedAt}`, query),
      pattern
        ? or(
            plate ? ilike(trips.plateNo, likeText(plate)) : undefined,
            plate ? ilike(vehicles.plateNo, likeText(plate)) : undefined,
            ilike(trips.tripNo, pattern),
            ilike(registrationAllocations.contractNo, pattern),
            ilike(registrationAllocations.doNo, pattern),
          )
        : undefined,
    );
    const joins = {
      trip: eq(trips.id, tripAllocations.tripId),
      registration: eq(registrations.id, trips.registrationId),
      allocation: eq(registrationAllocations.id, tripAllocations.registrationAllocationId),
      contract: eq(erpContracts.id, registrationAllocations.contractId),
      order: eq(deliveryOrders.id, registrationAllocations.deliveryOrderId),
      vehicle: eq(vehicles.id, trips.vehicleId),
      first: and(eq(first.tripId, trips.id), eq(first.stage, 1), eq(first.status, "VALID")),
      second: and(eq(second.tripId, trips.id), eq(second.stage, 2), eq(second.status, "VALID")),
    };

    const listed = orm
      .select({
      tripId: trips.id,
      tripNo: trips.tripNo,
      status: trips.status,
      outcome: trips.outcome,
      direction: registrations.direction,
      plateNo: trips.plateNo,
      vehiclePlate: vehicles.plateNo,
      seq: tripAllocations.seq,
      contractNo: registrationAllocations.contractNo,
      doNo: registrationAllocations.doNo,
      uom: sql<string>`coalesce(${deliveryOrders.uom}, ${erpContracts.uom}, 'kg')`,
      grossKg: trips.grossKg,
      tareKg: trips.tareKg,
      truckNetKg: trips.netKg,
      shareNetKg: tripAllocations.netKg,
      qtyActual: tripAllocations.qtyActual,
      splitMethod: tripAllocations.splitMethod,
      weigh1At: first.weighedAt,
      weigh2At: second.weighedAt,
      })
      .from(tripAllocations)
      .innerJoin(trips, joins.trip)
      .innerJoin(registrations, joins.registration)
      .innerJoin(registrationAllocations, joins.allocation)
      .leftJoin(erpContracts, joins.contract)
      .leftJoin(deliveryOrders, joins.order)
      .leftJoin(vehicles, joins.vehicle)
      .innerJoin(first, joins.first)
      .leftJoin(second, joins.second)
      .where(where)
      .orderBy(asc(first.weighedAt), asc(trips.id), asc(tripAllocations.seq));
    const rows = query.format === "csv" ? await listed : await listed.limit(query.limit).offset(query.offset);
    const items = rows.map(({ vehiclePlate, plateNo, ...row }) => ({ ...row, plateNo: plateNo ?? vehiclePlate }));
    if (query.format === "csv") {
      return sendCsv(
        reply,
        "timbang-per-truk.csv",
        ["Nomor trip", "Status", "Hasil", "Arah", "Plat", "Urutan", "Nomor kontrak", "Nomor DO", "Satuan", "Bruto", "Tarra", "Netto truk", "Bagian netto", "Realisasi", "Cara bagi", "Timbang 1", "Timbang 2"],
        items.map((row) => [
          row.tripNo, row.status, row.outcome, row.direction, row.plateNo, row.seq, row.contractNo, row.doNo, row.uom, row.grossKg, row.tareKg, row.truckNetKg, row.shareNetKg, row.qtyActual,
          row.splitMethod, row.weigh1At, row.weigh2At,
        ]),
      );
    }
    // the joins the filter reads (the vehicle plate, the first weighing); the others only add columns
    const [summed] = await orm
      .select({ lines: count(), trucks: sql<number>`count(distinct ${trips.id})`.mapWith(Number), shareNetKg: sql<string | null>`sum(${tripAllocations.netKg})` })
      .from(tripAllocations)
      .innerJoin(trips, joins.trip)
      .innerJoin(registrations, joins.registration)
      .innerJoin(registrationAllocations, joins.allocation)
      .leftJoin(vehicles, joins.vehicle)
      .innerJoin(first, joins.first)
      .where(where);
    return {
      items,
      total: Number(summed?.lines ?? 0),
      limit: query.limit,
      offset: query.offset,
      totals: { tripCount: summed?.trucks ?? 0, shareNetKg: amount(summed?.shareNetKg) },
    };
  });
}
