// From old rows to archive rows. A mapped row carries the typed columns, the rest of the old rows in `details`,
// and per source column what was rounded or could not be read (the original text is kept in details.original).
import { lettersAndDigits } from "../http.js";
import type { LegacyApproval, LegacyRegistration, LegacyReport, LegacyRow } from "./reader.js";
import { compact, flagOf, type Parsed, parseDate, parseDateTime, parseKg, parseNumber, textOf } from "./values.js";

/** Values a mapping could not take as they were, per "table.column". */
export class ValueNotes {
  readonly unparsed: string[] = [];
  readonly rounded: string[] = [];
  readonly original: Record<string, string> = {};

  take<T>(column: string, raw: unknown, parsed: Parsed<T>): T | null {
    if (parsed.status === "UNPARSED" || parsed.status === "ROUNDED") {
      (parsed.status === "UNPARSED" ? this.unparsed : this.rounded).push(column);
      this.original[column] = textOf(raw) ?? "";
    }
    return parsed.value;
  }
}

export type TripState = "COMPLETED" | "REJECTED_QC" | "REJECTED_CLEANLINESS" | "UNFINISHED";

/** The old flags: a finished truck is type OUT with finish 1; finish 4 was refused by QC, 3 at the cleanliness check. */
export function stateOf(type: unknown, finish: unknown): TripState {
  const done = textOf(finish);
  if (done === "4") return "REJECTED_QC";
  if (done === "3") return "REJECTED_CLEANLINESS";
  if (textOf(type)?.toUpperCase() === "OUT" && done === "1") return "COMPLETED";
  return "UNFINISHED";
}

const DIRECTIONS: Record<string, "IN" | "OUT"> = { "1": "IN", "2": "OUT" };
const MATERIALS: Record<string, string> = { "1": "CPO", "2": "IN_GOODS", "3": "OUT_BULK", "4": "OUT_PACKED" };

/** The site of an old row (signature), UNKNOWN when it is empty. */
export const siteOf = (signature: unknown) => textOf(signature)?.toUpperCase() ?? "UNKNOWN";

/** Text columns copied as they are: archive column, registrasi column. */
const TRIP_TEXTS = [
  ["ticket_no", "no_ticket"],
  ["plate_text", "no_polisi"],
  ["driver_name", "driver_name"],
  ["licence_no", "sim"],
  ["transporter", "transporter"],
  ["partner_name", "partner_name"],
  ["mill", "asal_pks"],
  ["product_name", "product_name"],
  ["uom", "satuan"],
  ["reference", "origin"],
  ["do_no", "no_do"],
  ["po_no", "no_po"],
  ["spb_no", "no_spb"],
  ["handover_no", "no_penyerahan"],
] as const;
const TRIP_FLAGS = ["jenis", "jenis_material", "signature", "type", "finish", "wight", "aktif"];
const TRIP_CONSUMED = [
  "id", "parent_id", "close_cargo", "flexi_bag", "tgl_entry", "tgl_masuk_truk", "tgl_keluar_truk", "bruto_from", "tarra_from", "netto_from",
  ...TRIP_FLAGS, ...TRIP_TEXTS.map(([, source]) => source),
];
const WEIGHING_CONSUMED = ["reg_id", "bruto", "tarra", "netto", "tgl_timbang1", "tgl_timbang2", "usr_timbang1", "usr_timbang2"];
const SEAL_COLUMNS = ["segel1", "segel2", "segel3", "segel4"];

/** The columns of legacy_trips the importer writes, with their SQL types, in one order for every statement. */
export const TRIP_COLUMNS = [
  ["site", "text"], ["legacy_id", "bigint"], ["ticket_no", "text"], ["direction", "text"], ["material", "text"], ["state", "text"],
  ["entry_date", "date"], ["arrived_at", "timestamptz"], ["left_at", "timestamptz"], ["plate_text", "text"], ["plate_no", "text"],
  ["driver_name", "text"], ["licence_no", "text"], ["transporter", "text"], ["partner_name", "text"], ["mill", "text"], ["product_name", "text"],
  ["uom", "text"], ["reference", "text"], ["do_no", "text"], ["po_no", "text"], ["spb_no", "text"], ["handover_no", "text"],
  ["doc_gross_kg", "integer"], ["doc_tare_kg", "integer"], ["doc_net_kg", "integer"], ["gross_kg", "integer"], ["tare_kg", "integer"], ["net_kg", "integer"],
  ["weigh1_at", "timestamptz"], ["weigh2_at", "timestamptz"], ["weigh1_by", "text"], ["weigh2_by", "text"], ["group_id", "bigint"],
  ["close_cargo", "boolean"], ["flexi_bag", "boolean"], ["details", "jsonb"],
] as const;

export const EXCEPTION_COLUMNS = [
  ["site", "text"], ["source", "text"], ["legacy_id", "bigint"], ["legacy_reg_id", "bigint"], ["type", "text"], ["status", "text"], ["decision", "text"],
  ["ticket_no", "text"], ["plate_text", "text"], ["driver_name", "text"], ["transporter", "text"], ["reference", "text"],
  ["doc_gross_kg", "integer"], ["weighed_gross_kg", "integer"], ["weighed_tare_kg", "integer"], ["weighed_net_kg", "integer"], ["diff_kg", "integer"],
  ["diff_pct", "numeric"], ["tolerance_pct", "numeric"], ["requested_at", "timestamptz"], ["responded_at", "timestamptz"], ["responded_by", "text"],
  ["report_no", "text"], ["report_at", "timestamptz"], ["report_by", "text"], ["details", "jsonb"],
] as const;

export type ArchiveRow = Record<string, unknown>;
export interface Mapped {
  row: ArchiveRow;
  notes: ValueNotes;
}

const newest = (rows: LegacyRow[]) => rows[rows.length - 1] ?? null;
/** The newest row as an object and the older ones, without reg_id, or nothing when there is no row. */
function related(rows: LegacyRow[], drop: string[] = ["reg_id"]) {
  const last = newest(rows);
  return { current: last ? compact(last, drop) : null, older: rows.slice(0, -1).map((row) => compact(row, ["reg_id"])) };
}

/** A positive legacy id, or null. */
export function legacyIdOf(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** One old registration as a legacy_trips row; null when it has no usable id. */
export function mapRegistration(bundle: LegacyRegistration): Mapped | null {
  const r = bundle.registration;
  const legacyId = legacyIdOf(r.id);
  if (legacyId === null) return null;
  const notes = new ValueNotes();
  const at = (table: string, row: LegacyRow | null, column: string, parse: (value: unknown) => Parsed<unknown>) =>
    row ? notes.take(`${table}.${column}`, row[column], parse(row[column])) : null;

  const weighing = related(bundle.weighings, WEIGHING_CONSUMED);
  const w = newest(bundle.weighings);
  const parentId = legacyIdOf(r.parent_id);
  const groupId = parentId ?? (bundle.childCount > 0 ? legacyId : null);
  const qc = related(bundle.qc);
  const unloading = related(bundle.unloading);
  const loading = related(bundle.loading);
  const loadRow = newest(bundle.loading);
  const seals = loadRow ? SEAL_COLUMNS.map((column) => textOf(loadRow[column])).filter((seal) => seal !== null) : [];

  const row: ArchiveRow = {
    site: siteOf(r.signature),
    legacy_id: legacyId,
    direction: DIRECTIONS[textOf(r.jenis) ?? ""] ?? "UNKNOWN",
    material: MATERIALS[textOf(r.jenis_material) ?? ""] ?? null,
    state: stateOf(r.type, r.finish),
    entry_date: at("registrasi", r, "tgl_entry", parseDate),
    arrived_at: at("registrasi", r, "tgl_masuk_truk", parseDateTime),
    left_at: at("registrasi", r, "tgl_keluar_truk", parseDateTime),
    ...Object.fromEntries(TRIP_TEXTS.map(([target, source]) => [target, textOf(r[source])])),
    plate_no: textOf(r.no_polisi) === null ? null : lettersAndDigits(String(r.no_polisi)) || null,
    doc_gross_kg: at("registrasi", r, "bruto_from", parseKg),
    doc_tare_kg: at("registrasi", r, "tarra_from", parseKg),
    doc_net_kg: at("registrasi", r, "netto_from", parseKg),
    gross_kg: at("timbangan", w, "bruto", parseKg),
    tare_kg: at("timbangan", w, "tarra", parseKg),
    net_kg: at("timbangan", w, "netto", parseKg),
    weigh1_at: at("timbangan", w, "tgl_timbang1", parseDateTime),
    weigh2_at: at("timbangan", w, "tgl_timbang2", parseDateTime),
    weigh1_by: w ? textOf(w.usr_timbang1) : null,
    weigh2_by: w ? textOf(w.usr_timbang2) : null,
    group_id: groupId,
    close_cargo: flagOf(r.close_cargo),
    flexi_bag: flagOf(r.flexi_bag),
  };
  const details: Record<string, unknown> = {
    flags: compact(Object.fromEntries(TRIP_FLAGS.map((flag) => [flag, r[flag]]))),
    registration: compact(r, TRIP_CONSUMED),
    weighing: weighing.current,
    otherWeighings: weighing.older,
    qc: qc.current,
    unloading: unloading.current,
    loading: loading.current,
    seals,
    splits: bundle.splits.map((split) => compact(split, ["reg_id"])),
    older: { qc: qc.older, unloading: unloading.older, loading: loading.older },
    original: notes.original,
  };
  row.details = pruned(details);
  return { row, notes };
}

/** Drops empty lists, empty objects and nulls at the top level and one level down, so equal rows compare equal. */
function pruned(details: Record<string, unknown>): Record<string, unknown> {
  const isEmpty = (value: unknown): boolean =>
    value === null || value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every(isEmpty));
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (isEmpty(value)) continue;
    if (typeof value === "object" && !Array.isArray(value) && value !== null && key === "older") {
      kept[key] = Object.fromEntries(Object.entries(value).filter(([, inner]) => !isEmpty(inner)));
    } else kept[key] = value;
  }
  return kept;
}

const APPROVAL_CONSUMED = [
  "id", "reg_id", "signature", "tipe", "status", "keputusan", "no_ticket", "no_polisi", "driver_name", "transporter", "origin", "bruto_from", "bruto_wb",
  "tarra_wb", "netto_wb", "selisih", "selisih_persen", "toleransi_persen", "requested_at", "responded_at", "responded_by", "selisih_id",
];
const REPORT_CONSUMED = ["id", "reg_id", "no_ba", "tgl_ba", "dibuat_oleh"];

function reportColumns(notes: ValueNotes, report: LegacyRow | null) {
  const at = (column: string, parse: (value: unknown) => Parsed<unknown>) => (report ? notes.take(`selisih.${column}`, report[column], parse(report[column])) : null);
  return { report_no: report ? textOf(report.no_ba) : null, report_at: at("tgl_ba", parseDateTime), report_by: report ? textOf(report.dibuat_oleh) : null };
}

/** An approval request with its BA as a legacy_exceptions row. */
export function mapApproval({ approval: a, report }: LegacyApproval): Mapped | null {
  const legacyId = legacyIdOf(a.id);
  if (legacyId === null) return null;
  const notes = new ValueNotes();
  const at = (column: string, parse: (value: unknown) => Parsed<unknown>) => notes.take(`selisih_approval.${column}`, a[column], parse(a[column]));
  const row: ArchiveRow = {
    site: siteOf(a.signature),
    source: "APPROVAL",
    legacy_id: legacyId,
    legacy_reg_id: legacyIdOf(a.reg_id),
    type: textOf(a.tipe),
    status: textOf(a.status),
    decision: textOf(a.keputusan),
    ticket_no: textOf(a.no_ticket),
    plate_text: textOf(a.no_polisi),
    driver_name: textOf(a.driver_name),
    transporter: textOf(a.transporter),
    reference: textOf(a.origin),
    doc_gross_kg: at("bruto_from", parseKg),
    weighed_gross_kg: at("bruto_wb", parseKg),
    weighed_tare_kg: at("tarra_wb", parseKg),
    weighed_net_kg: at("netto_wb", parseKg),
    diff_kg: at("selisih", parseKg),
    diff_pct: at("selisih_persen", parseNumber),
    tolerance_pct: at("toleransi_persen", parseNumber),
    requested_at: at("requested_at", parseDateTime),
    responded_at: at("responded_at", parseDateTime),
    responded_by: textOf(a.responded_by),
    ...reportColumns(notes, report),
  };
  row.details = pruned({ approval: compact(a, APPROVAL_CONSUMED), report: compact(report, REPORT_CONSUMED), original: notes.original });
  return { row, notes };
}

/** A BA without an approval as a legacy_exceptions row. */
export function mapReport({ report: s, site }: LegacyReport): Mapped | null {
  const legacyId = legacyIdOf(s.id);
  if (legacyId === null) return null;
  const notes = new ValueNotes();
  const at = (column: string, parse: (value: unknown) => Parsed<unknown>) => notes.take(`selisih.${column}`, s[column], parse(s[column]));
  const row: ArchiveRow = {
    site: siteOf(site),
    source: "REPORT",
    legacy_id: legacyId,
    legacy_reg_id: legacyIdOf(s.reg_id),
    type: null,
    status: null,
    decision: null,
    ticket_no: textOf(s.no_ticket),
    plate_text: textOf(s.no_polisi),
    driver_name: textOf(s.driver_name),
    transporter: textOf(s.transporter),
    reference: textOf(s.origin),
    doc_gross_kg: at("bruto_from", parseKg),
    weighed_gross_kg: at("bruto_wb", parseKg),
    weighed_tare_kg: null,
    weighed_net_kg: null,
    diff_kg: at("selisih", parseKg),
    diff_pct: at("selisih_persen", parseNumber),
    tolerance_pct: null,
    requested_at: null,
    responded_at: null,
    responded_by: null,
    ...reportColumns(notes, s),
  };
  row.details = pruned({
    report: compact(s, [...REPORT_CONSUMED, "no_ticket", "no_polisi", "driver_name", "transporter", "origin", "bruto_from", "bruto_wb", "selisih", "selisih_persen"]),
    original: notes.original,
  });
  return { row, notes };
}
