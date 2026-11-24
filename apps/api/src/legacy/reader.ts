// Reads the old weighbridge database (PostgreSQL 12) for `npm run legacy:import`. The session is read only: every
// transaction of it starts with default_transaction_read_only=on, so a statement that writes fails on the server.
// Rows come back as the server's to_jsonb of the whole old row, so the importer sees every column whatever its type
// (text, numbers, timestamps as ISO text without an offset).
import postgres from "postgres";

/** One old row as JSON: column name to value. */
export type LegacyRow = Record<string, unknown>;

/** A registration with the rows that belong to it, each list ordered by id. */
export interface LegacyRegistration {
  registration: LegacyRow;
  /** How many registrations name this one as their parent_id (a multi-contract group). */
  childCount: number;
  weighings: LegacyRow[];
  qc: LegacyRow[];
  unloading: LegacyRow[];
  loading: LegacyRow[];
  /** registrasi_wight: how the net of a multi-contract truck was split. */
  splits: LegacyRow[];
}

/** An approval request with the deviation report (BA) it points to. */
export interface LegacyApproval {
  approval: LegacyRow;
  report: LegacyRow | null;
}

/** A deviation report no approval points to, with the site of its registration. */
export interface LegacyReport {
  report: LegacyRow;
  site: string | null;
}

/**
 * What the importer reads. Lists are paged by ascending id: `afterId` is the last id of the previous page.
 * `since` (YYYY-MM-DD) limits registrations to an entry date, approvals to a request date and reports to a
 * report date on or after it.
 */
export interface LegacyReader {
  registrations(afterId: number, limit: number, since: string | null): Promise<LegacyRegistration[]>;
  approvals(afterId: number, limit: number, since: string | null): Promise<LegacyApproval[]>;
  reports(afterId: number, limit: number, since: string | null): Promise<LegacyReport[]>;
  /** ms_truck, every row. */
  trucks(): Promise<LegacyRow[]>;
  /** mnosegel rows not marked used (terpakai <> '1'). */
  unusedSeals(afterId: number, limit: number): Promise<LegacyRow[]>;
  /** The distinct card UIDs typed on registrations, without empty values. */
  cardUids(): Promise<string[]>;
  close(): Promise<void>;
}

export const LEGACY_APPLICATION_NAME = "timbangan-registrasi legacy import";
/** The longest one statement may run on the old server. */
export const LEGACY_STATEMENT_TIMEOUT_MS = 120_000;

/** A read-only session to the old database: writes fail on the server, long statements are cancelled. */
export function openLegacySession(url: string): postgres.Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: {
      default_transaction_read_only: true,
      statement_timeout: LEGACY_STATEMENT_TIMEOUT_MS,
      application_name: LEGACY_APPLICATION_NAME,
    },
  });
}

const regId = (row: LegacyRow) => Number(row.reg_id);
const idOf = (row: LegacyRow) => Number(row.id);

/** Rows of one batch grouped by reg_id. */
function byRegistration(rows: { row: LegacyRow }[]): Map<number, LegacyRow[]> {
  const grouped = new Map<number, LegacyRow[]>();
  for (const { row } of rows) {
    const key = regId(row);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  for (const list of grouped.values()) list.sort((a, b) => idOf(a) - idOf(b));
  return grouped;
}

export class PostgresLegacyReader implements LegacyReader {
  constructor(private readonly sql: postgres.Sql) {}

  static open(url: string): PostgresLegacyReader {
    return new PostgresLegacyReader(openLegacySession(url));
  }

  private rows(text: string, params: (string | number)[]): Promise<postgres.Row[]> {
    return this.sql.unsafe(text, params);
  }

  async registrations(afterId: number, limit: number, since: string | null): Promise<LegacyRegistration[]> {
    const heads = await this.rows(
      `select to_jsonb(r) as row from registrasi r
       where r.id > $1 and ($3::text is null or r.tgl_entry >= $3::text)
       order by r.id limit $2`,
      [afterId, limit, since as string],
    );
    if (heads.length === 0) return [];
    const regs = heads.map((head) => head.row as LegacyRow);
    const low = idOf(regs[0] as LegacyRow);
    const high = idOf(regs[regs.length - 1] as LegacyRow);
    // one range read per table and batch: the old tables may have no index on reg_id
    const childRows = await this.rows("select parent_id::float8 as parent_id, count(*)::int as n from registrasi where parent_id between $1 and $2 group by parent_id", [low, high]);
    const children = new Map(childRows.map((row) => [Number(row.parent_id), Number(row.n)]));
    const related = async (table: string) => byRegistration((await this.rows(`select to_jsonb(t) as row from ${table} t where t.reg_id between $1 and $2`, [low, high])) as { row: LegacyRow }[]);
    const weighings = await related("timbangan");
    const qc = await related("qcpass");
    const unloading = await related("unload");
    const loading = await related("load");
    const splits = await related("registrasi_wight");
    return regs.map((registration) => {
      const id = idOf(registration);
      return {
        registration,
        childCount: children.get(id) ?? 0,
        weighings: weighings.get(id) ?? [],
        qc: qc.get(id) ?? [],
        unloading: unloading.get(id) ?? [],
        loading: loading.get(id) ?? [],
        splits: splits.get(id) ?? [],
      };
    });
  }

  async approvals(afterId: number, limit: number, since: string | null): Promise<LegacyApproval[]> {
    const rows = await this.rows(
      `select to_jsonb(a) as approval, to_jsonb(s) as report from selisih_approval a left join selisih s on s.id = a.selisih_id
       where a.id > $1 and ($3::text is null or a.requested_at >= $3::date)
       order by a.id limit $2`,
      [afterId, limit, since as string],
    );
    return rows.map((row) => ({ approval: row.approval as LegacyRow, report: (row.report as LegacyRow | null) ?? null }));
  }

  async reports(afterId: number, limit: number, since: string | null): Promise<LegacyReport[]> {
    const rows = await this.rows(
      `select to_jsonb(s) as report, r.signature as site from selisih s left join registrasi r on r.id = s.reg_id
       where s.id > $1 and ($3::text is null or s.tgl_ba >= $3::date)
         and not exists (select 1 from selisih_approval a where a.selisih_id = s.id)
       order by s.id limit $2`,
      [afterId, limit, since as string],
    );
    return rows.map((row) => ({ report: row.report as LegacyRow, site: (row.site as string | null) ?? null }));
  }

  async trucks(): Promise<LegacyRow[]> {
    return (await this.rows("select to_jsonb(t) as row from ms_truck t order by t.id", [])).map((row) => row.row as LegacyRow);
  }

  async unusedSeals(afterId: number, limit: number): Promise<LegacyRow[]> {
    const rows = await this.rows("select to_jsonb(m) as row from mnosegel m where m.id > $1 and coalesce(m.terpakai, '') <> '1' order by m.id limit $2", [afterId, limit]);
    return rows.map((row) => row.row as LegacyRow);
  }

  async cardUids(): Promise<string[]> {
    const rows = await this.rows("select distinct trim(rfid) as uid from registrasi where trim(coalesce(rfid, '')) <> '' order by 1", []);
    return rows.map((row) => String(row.uid));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
