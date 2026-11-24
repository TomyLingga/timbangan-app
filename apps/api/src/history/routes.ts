// The archive of the old weighbridge application (module `reports`, staff only): a searchable list of old trucks
// and one truck with everything kept of it. Read only: no route here changes the archive.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { invalid, notFound } from "../errors.js";
import { dateText, idParams, lettersAndDigits, likeText, searchParam } from "../http.js";
import { sendCsv } from "../reports/routes.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const LIMIT_MESSAGE = "Limit harus angka mulai dari 1.";
const OFFSET_MESSAGE = "Offset harus angka mulai dari 0.";

const listQuery = z.object({
  q: searchParam,
  from: dateText("Tanggal awal").optional(),
  to: dateText("Tanggal akhir").optional(),
  direction: z.enum(["IN", "OUT", "UNKNOWN"], "Arah harus IN, OUT, atau UNKNOWN.").optional(),
  state: z.enum(["COMPLETED", "REJECTED_QC", "REJECTED_CLEANLINESS", "UNFINISHED"], "Keadaan harus COMPLETED, REJECTED_QC, REJECTED_CLEANLINESS, atau UNFINISHED.").optional(),
  site: z.string("Cabang harus berupa teks.").trim().toUpperCase().max(20, "Cabang terlalu panjang.").optional(),
  limit: z.coerce.number(LIMIT_MESSAGE).int(LIMIT_MESSAGE).min(1, LIMIT_MESSAGE).default(PAGE_SIZE).transform((value) => Math.min(value, MAX_PAGE_SIZE)),
  offset: z.coerce.number(OFFSET_MESSAGE).int(OFFSET_MESSAGE).min(0, OFFSET_MESSAGE).default(0),
  format: z.enum(["json", "csv"], "Format harus json atau csv.").default("json"),
});

/** Columns of a listed row: archive column, answer key. Dates and times are formatted by the query. */
const TRIP_FIELDS = [
  ["id", "id"], ["site", "site"], ["legacy_id", "legacyId"], ["ticket_no", "ticketNo"], ["direction", "direction"], ["material", "material"], ["state", "state"],
  ["entry_date", "entryDate"], ["arrived_at", "arrivedAt"], ["left_at", "leftAt"], ["plate_text", "plateText"], ["plate_no", "plateNo"], ["driver_name", "driverName"],
  ["licence_no", "licenceNo"], ["transporter", "transporter"], ["partner_name", "partnerName"], ["mill", "mill"], ["product_name", "productName"], ["uom", "uom"],
  ["reference", "reference"], ["do_no", "doNo"], ["po_no", "poNo"], ["spb_no", "spbNo"], ["handover_no", "handoverNo"], ["doc_gross_kg", "docGrossKg"],
  ["doc_tare_kg", "docTareKg"], ["doc_net_kg", "docNetKg"], ["gross_kg", "grossKg"], ["tare_kg", "tareKg"], ["net_kg", "netKg"], ["weigh1_at", "weigh1At"],
  ["weigh2_at", "weigh2At"], ["weigh1_by", "weigh1By"], ["weigh2_by", "weigh2By"], ["group_id", "groupId"], ["close_cargo", "closeCargo"], ["flexi_bag", "flexiBag"],
] as const;
const DETAIL_FIELDS = [["imported_at", "importedAt"], ["updated_at", "updatedAt"], ["details", "details"]] as const;
const EXCEPTION_FIELDS = [
  ["id", "id"], ["site", "site"], ["source", "source"], ["legacy_id", "legacyId"], ["legacy_reg_id", "legacyRegId"], ["type", "type"], ["status", "status"],
  ["decision", "decision"], ["ticket_no", "ticketNo"], ["plate_text", "plateText"], ["driver_name", "driverName"], ["transporter", "transporter"],
  ["reference", "reference"], ["doc_gross_kg", "docGrossKg"], ["weighed_gross_kg", "weighedGrossKg"], ["weighed_tare_kg", "weighedTareKg"],
  ["weighed_net_kg", "weighedNetKg"], ["diff_kg", "diffKg"], ["diff_pct", "diffPct"], ["tolerance_pct", "tolerancePct"], ["requested_at", "requestedAt"],
  ["responded_at", "respondedAt"], ["responded_by", "respondedBy"], ["report_no", "reportNo"], ["report_at", "reportAt"], ["report_by", "reportBy"], ["details", "details"],
] as const;

/** How a column is selected so both drivers answer the same JavaScript value. */
function selected(column: string): string {
  if (column === "entry_date") return "to_char(entry_date, 'YYYY-MM-DD') as entry_date";
  if (column === "id" || column === "legacy_id" || column === "group_id" || column === "legacy_reg_id") return `${column}::float8 as ${column}`;
  if (column === "diff_pct" || column === "tolerance_pct") return `${column}::float8 as ${column}`;
  return column;
}
const selectList = (fields: readonly (readonly [string, string])[]) => fields.map(([column]) => selected(column)).join(", ");

function shaped(row: Record<string, unknown>, fields: readonly (readonly [string, string])[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, key] of fields) {
    const value = row[column];
    out[key] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return out;
}

const CSV_HEADER = [
  "Cabang", "Id lama", "Nomor tiket", "Arah", "Keadaan", "Tanggal entry", "Masuk", "Keluar", "Plat", "Supir", "SIM", "Transporter", "Partner", "Asal PKS", "Produk",
  "Satuan", "Kontrak atau DO", "Nomor DO", "PO", "SPB", "Nomor penyerahan", "Bruto surat", "Tarra surat", "Netto surat", "Bruto", "Tarra", "Netto", "Timbang 1",
  "Timbang 2", "Kelompok", "Close cargo", "Flexi bag",
];
const CSV_KEYS = [
  "site", "legacyId", "ticketNo", "direction", "state", "entryDate", "arrivedAt", "leftAt", "plateText", "driverName", "licenceNo", "transporter", "partnerName", "mill",
  "productName", "uom", "reference", "doNo", "poNo", "spbNo", "handoverNo", "docGrossKg", "docTareKg", "docNetKg", "grossKg", "tareKg", "netKg", "weigh1At",
  "weigh2At", "groupId", "closeCargo", "flexiBag",
];
const yesNo = (value: unknown) => (value === true ? "ya" : value === false ? "tidak" : null);

export function registerHistoryRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const database = context.database;
  const readers = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("reports", "VIEW")] };

  app.get("/api/history/trips", readers, async (request, reply) => {
    const query = listQuery.parse(request.query);
    if (query.from && query.to && query.from > query.to) throw invalid("to", "Tanggal akhir tidak boleh sebelum tanggal awal.");

    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (query.q) {
      const pattern = param(likeText(query.q));
      const found = [`ticket_no = ${param(query.q)}`, `reference ilike ${pattern}`, `do_no ilike ${pattern}`, `driver_name ilike ${pattern}`];
      const plate = lettersAndDigits(query.q);
      if (plate) found.push(`plate_no like ${param(likeText(plate))}`);
      where.push(`(${found.join(" or ")})`);
    }
    if (query.from) where.push(`entry_date >= ${param(query.from)}::date`);
    if (query.to) where.push(`entry_date <= ${param(query.to)}::date`);
    if (query.direction) where.push(`direction = ${param(query.direction)}`);
    if (query.state) where.push(`state = ${param(query.state)}`);
    if (query.site) where.push(`site = ${param(query.site)}`);
    const filter = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const order = "order by entry_date desc nulls last, legacy_id desc";

    if (query.format === "csv") {
      const rows = await database.query(`select ${selectList(TRIP_FIELDS)} from legacy_trips ${filter} ${order}`, params);
      const items = rows.map((row) => shaped(row, TRIP_FIELDS));
      return sendCsv(
        reply,
        "riwayat-lama.csv",
        CSV_HEADER,
        items.map((item) => CSV_KEYS.map((key) => (key === "closeCargo" || key === "flexiBag" ? yesNo(item[key]) : item[key]))),
      );
    }

    const page = [...params, query.limit, query.offset];
    const rows = await database.query(`select ${selectList(TRIP_FIELDS)} from legacy_trips ${filter} ${order} limit $${params.length + 1} offset $${params.length + 2}`, page);
    // a multi-contract group is one truck; the net counts the trucks that finished
    const [summed] = await database.query<{ total: number; trucks: number; completed: number; net: number | null }>(
      `select count(*)::int as total, count(distinct coalesce(group_id, legacy_id))::int as trucks,
              count(distinct coalesce(group_id, legacy_id)) filter (where state = 'COMPLETED')::int as completed,
              (sum(net_kg) filter (where state = 'COMPLETED'))::float8 as net
       from legacy_trips ${filter}`,
      params,
    );
    return {
      items: rows.map((row) => shaped(row, TRIP_FIELDS)),
      total: Number(summed?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
      totals: { trucks: Number(summed?.trucks ?? 0), completedTrucks: Number(summed?.completed ?? 0), netKg: Number(summed?.net ?? 0) },
    };
  });

  app.get("/api/history/trips/:id", readers, async (request) => {
    const { id } = idParams.parse(request.params);
    const [row] = await database.query(`select ${selectList([...TRIP_FIELDS, ...DETAIL_FIELDS])} from legacy_trips where id = $1`, [id]);
    if (!row) throw notFound("Riwayat lama");
    const trip = shaped(row, [...TRIP_FIELDS, ...DETAIL_FIELDS]);
    const group =
      trip.groupId === null
        ? []
        : await database.query(`select ${selectList(TRIP_FIELDS)} from legacy_trips where site = $1 and group_id = $2 and id <> $3 order by legacy_id`, [trip.site, trip.groupId, id]);
    const exceptions = await database.query(
      `select ${selectList(EXCEPTION_FIELDS)} from legacy_exceptions where legacy_reg_id = $1 order by requested_at nulls last, report_at nulls last, id`,
      [trip.legacyId],
    );
    return {
      trip,
      group: group.map((member) => shaped(member, TRIP_FIELDS)),
      exceptions: exceptions.map((exception) => shaped(exception, EXCEPTION_FIELDS)),
    };
  });
}
