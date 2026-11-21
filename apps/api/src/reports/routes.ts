// Reports for the holders of `reports`: realisation per contract, and one line per truck allocation. Both
// answer JSON, or CSV with `?format=csv`.
import { and, asc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { deliveryOrders, erpContracts, partners, products, registrationAllocations, registrations, tripAllocations, trips, vehicles, weighings } from "../db/schema.js";
import { invalid } from "../errors.js";
import { dateText, likeText, PLANT_TIME_ZONE, searchParam } from "../http.js";

const MAX_ROWS = 5_000;
const period = {
  from: dateText("Tanggal awal").optional(),
  to: dateText("Tanggal akhir").optional(),
  direction: z.enum(["IN", "OUT"], "Arah harus IN atau OUT.").optional(),
  format: z.enum(["json", "csv"], "Format harus json atau csv.").default("json"),
};
const contractsQuery = z.object({ ...period, q: searchParam });
const tripsQuery = z.object(period);

function checkPeriod(query: { from?: string; to?: string }): void {
  if (query.from && query.to && query.from > query.to) throw invalid("to", "Tanggal akhir tidak boleh sebelum tanggal awal.");
}

/** The plant date of a timestamp column is within the period (either end may be open). */
function inPeriod(column: SQL | typeof trips.completedAt, query: { from?: string; to?: string }): SQL | undefined {
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

export function registerReportRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const readers = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("reports", "VIEW")] };

  app.get("/api/reports/contracts", readers, async (request, reply) => {
    const query = contractsQuery.parse(request.query);
    checkPeriod(query);
    const contracts = await orm
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
      })
      .from(erpContracts)
      .innerJoin(partners, eq(partners.id, erpContracts.partnerId))
      .innerJoin(products, eq(products.id, erpContracts.productId))
      .where(
        and(
          query.direction ? eq(erpContracts.direction, query.direction) : undefined,
          query.q ? or(ilike(erpContracts.contractNo, likeText(query.q)), ilike(partners.name, likeText(query.q))) : undefined,
        ),
      )
      .orderBy(asc(erpContracts.contractNo), asc(erpContracts.id))
      .limit(MAX_ROWS);

    // every allocation of a truck to a contract, directly (incoming) or through its DO (outgoing)
    const ids = contracts.map((row) => row.id);
    const lines = ids.length
      ? await orm
          .select({
            contractId: sql<number>`coalesce(${registrationAllocations.contractId}, ${deliveryOrders.contractId})`.mapWith(Number),
            tripId: trips.id,
            status: trips.status,
            completedAt: trips.completedAt,
            qty: sql<string | null>`coalesce(${tripAllocations.qtyActual}, ${tripAllocations.netKg})`,
            planned: tripAllocations.qtyPlanned,
            inPeriod: query.from || query.to ? sql<boolean>`coalesce(${inPeriod(sql`${trips.completedAt}`, query)}, false)` : sql<boolean>`true`,
          })
          .from(tripAllocations)
          .innerJoin(trips, eq(trips.id, tripAllocations.tripId))
          .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
          .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
          .where(
            and(
              or(inArray(registrationAllocations.contractId, ids), inArray(deliveryOrders.contractId, ids)),
              inArray(trips.status, ["COMPLETED", "CHECKED_IN", "IN_PROCESS"]),
            ),
          )
      : [];

    const items = contracts.map((contract) => {
      const own = lines.filter((line) => line.contractId === contract.id);
      const completed = own.filter((line) => line.status === "COMPLETED");
      const sum = (rows: typeof own, pick: (row: (typeof own)[number]) => number) => round3(rows.reduce((total, row) => total + pick(row), 0));
      const realisedTotal = sum(completed, (row) => Number(row.qty ?? 0));
      return {
        contractId: contract.id,
        contractNo: contract.contractNo,
        direction: contract.direction,
        partner: contract.partnerName,
        product: contract.productName,
        uom: contract.uom,
        state: contract.state,
        qtyContract: contract.qtyContract,
        qtyOpening: contract.qtyOpening,
        realised: sum(completed.filter((row) => row.inPeriod), (row) => Number(row.qty ?? 0)),
        realisedTotal,
        inProgress: sum(own.filter((row) => row.status !== "COMPLETED"), (row) => Number(row.planned ?? 0)),
        remaining: contract.qtyContract === null ? null : round3(contract.qtyContract - contract.qtyOpening - realisedTotal),
        tripCount: new Set(completed.filter((row) => row.inPeriod).map((row) => row.tripId)).size,
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
    return { items };
  });

  app.get("/api/reports/trips", readers, async (request, reply) => {
    const query = tripsQuery.parse(request.query);
    checkPeriod(query);
    const first = alias(weighings, "report_weigh_1");
    const second = alias(weighings, "report_weigh_2");
    const rows = await orm
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
      .innerJoin(trips, eq(trips.id, tripAllocations.tripId))
      .innerJoin(registrations, eq(registrations.id, trips.registrationId))
      .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
      .leftJoin(erpContracts, eq(erpContracts.id, registrationAllocations.contractId))
      .leftJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
      .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
      .innerJoin(first, and(eq(first.tripId, trips.id), eq(first.stage, 1), eq(first.status, "VALID")))
      .leftJoin(second, and(eq(second.tripId, trips.id), eq(second.stage, 2), eq(second.status, "VALID")))
      .where(and(query.direction ? eq(registrations.direction, query.direction) : undefined, inPeriod(sql`${first.weighedAt}`, query)))
      .orderBy(asc(first.weighedAt), asc(trips.id), asc(tripAllocations.seq))
      .limit(MAX_ROWS);
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
    return { items };
  });
}
