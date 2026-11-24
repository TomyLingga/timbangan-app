// A LegacyReader over made-up old rows held in memory, with the same paging and filters as the PostgreSQL reader.
// Rows look like what to_jsonb gives on the old server: ids and numeric columns as numbers, the rest as text.
// Every plate, name and number here is invented.
import type { LegacyApproval, LegacyReader, LegacyRegistration, LegacyReport, LegacyRow } from "../../src/legacy/reader.js";

export interface LegacyTables {
  registrasi: LegacyRow[];
  timbangan: LegacyRow[];
  qcpass: LegacyRow[];
  unload: LegacyRow[];
  load: LegacyRow[];
  registrasi_wight: LegacyRow[];
  selisih_approval: LegacyRow[];
  selisih: LegacyRow[];
  ms_truck: LegacyRow[];
  mnosegel: LegacyRow[];
}

const id = (row: LegacyRow) => Number(row.id);
const byId = (rows: LegacyRow[]) => [...rows].sort((a, b) => id(a) - id(b));
/** The date part of a to_jsonb timestamp ("2026-11-20T10:00:00"). */
const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : "");

export class FakeLegacyReader implements LegacyReader {
  readonly tables: LegacyTables;
  /** How many times each method was called, to see what a run read. */
  readonly calls: Record<string, number> = {};
  closed = false;

  constructor(tables: Partial<LegacyTables> = {}) {
    this.tables = {
      registrasi: [], timbangan: [], qcpass: [], unload: [], load: [], registrasi_wight: [], selisih_approval: [], selisih: [], ms_truck: [], mnosegel: [],
      ...structuredClone(tables),
    };
  }

  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  async registrations(afterId: number, limit: number, since: string | null): Promise<LegacyRegistration[]> {
    this.count("registrations");
    const t = this.tables;
    const of = (rows: LegacyRow[], regId: number) => byId(rows.filter((row) => Number(row.reg_id) === regId));
    return byId(t.registrasi)
      .filter((row) => id(row) > afterId && (since === null || String(row.tgl_entry ?? "") >= since))
      .slice(0, limit)
      .map((registration) => {
        const regId = id(registration);
        return {
          registration: structuredClone(registration),
          childCount: t.registrasi.filter((row) => Number(row.parent_id) === regId).length,
          weighings: of(t.timbangan, regId),
          qc: of(t.qcpass, regId),
          unloading: of(t.unload, regId),
          loading: of(t.load, regId),
          splits: of(t.registrasi_wight, regId),
        };
      });
  }

  async approvals(afterId: number, limit: number, since: string | null): Promise<LegacyApproval[]> {
    this.count("approvals");
    return byId(this.tables.selisih_approval)
      .filter((row) => id(row) > afterId && (since === null || day(row.requested_at) >= since))
      .slice(0, limit)
      .map((approval) => ({ approval: structuredClone(approval), report: this.tables.selisih.find((report) => id(report) === Number(approval.selisih_id)) ?? null }));
  }

  async reports(afterId: number, limit: number, since: string | null): Promise<LegacyReport[]> {
    this.count("reports");
    const pointed = new Set(this.tables.selisih_approval.map((row) => Number(row.selisih_id)));
    return byId(this.tables.selisih)
      .filter((row) => id(row) > afterId && !pointed.has(id(row)) && (since === null || day(row.tgl_ba) >= since))
      .slice(0, limit)
      .map((report) => ({ report: structuredClone(report), site: (this.tables.registrasi.find((row) => id(row) === Number(report.reg_id))?.signature as string | undefined) ?? null }));
  }

  async trucks(): Promise<LegacyRow[]> {
    this.count("trucks");
    return byId(this.tables.ms_truck);
  }

  async unusedSeals(afterId: number, limit: number): Promise<LegacyRow[]> {
    this.count("unusedSeals");
    return byId(this.tables.mnosegel)
      .filter((row) => id(row) > afterId && String(row.terpakai ?? "") !== "1")
      .slice(0, limit);
  }

  async cardUids(): Promise<string[]> {
    this.count("cardUids");
    const uids = new Set(this.tables.registrasi.map((row) => String(row.rfid ?? "").trim()).filter((uid) => uid !== ""));
    return [...uids].sort();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** An old registration with the columns the importer reads; `extra` adds or replaces columns. */
export function registration(regId: number, extra: LegacyRow = {}): LegacyRow {
  return {
    id: regId,
    jenis: "1",
    jenis_material: "1",
    signature: "SMK",
    type: "OUT",
    finish: "1",
    wight: "1",
    no_ticket: 5000 + regId,
    no_polisi: "BK 9001 XA",
    driver_name: "Supir Rekaan",
    sim: "SIMREKAAN01",
    transporter: "PT Angkut Rekaan",
    partner_name: "PT Sawit Rekaan",
    asal_pks: "PKS Rekaan",
    product_name: "CPO",
    satuan: "Kg",
    origin: "0001/KONTRAK/REK-A/B-CD/XI/2026",
    no_do: "-",
    no_po: null,
    no_spb: "SPB-REK-1",
    no_penyerahan: null,
    tgl_entry: "2026-11-20",
    tgl_masuk_truk: "2026-11-20 08:00:00",
    tgl_keluar_truk: "2026-11-20 10:00:00",
    bruto_from: "40000",
    tarra_from: "15000",
    netto_from: "25000",
    rfid: null,
    parent_id: null,
    close_cargo: 0,
    flexi_bag: 0,
    no_surat_jalan: "SJ-REK-1",
    ...extra,
  };
}

/** The weighing row of a registration. */
export function weighing(rowId: number, regId: number, extra: LegacyRow = {}): LegacyRow {
  return {
    id: rowId,
    reg_id: regId,
    bruto: "40010",
    tarra: "15005",
    netto: "25005",
    tgl_timbang1: "2026-11-20 08:30:00",
    tgl_timbang2: "2026-11-20 09:40:00",
    usr_timbang1: "petugas1",
    usr_timbang2: "petugas2",
    signature: "SMK",
    ...extra,
  };
}
