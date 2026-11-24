// The archive parts of the import: old registrations into legacy_trips, approvals and deviation reports into
// legacy_exceptions. Each batch is classified against what is stored (new, changed, unchanged) and, unless it is a
// dry run, upserted by its natural key in one transaction together with the run's progress.
import type { SqlRunner } from "../db/client.js";
import { bump, newCounts, type PartContext, type PartCounts } from "./counts.js";
import { EXCEPTION_COLUMNS, type Mapped, mapApproval, mapRegistration, mapReport, TRIP_COLUMNS } from "./map.js";

type Columns = readonly (readonly [string, string])[];

interface Target {
  table: "legacy_trips" | "legacy_exceptions";
  columns: Columns;
  key: string[];
}

const TRIPS: Target = { table: "legacy_trips", columns: TRIP_COLUMNS, key: ["site", "legacy_id"] };
const EXCEPTIONS: Target = { table: "legacy_exceptions", columns: EXCEPTION_COLUMNS, key: ["site", "source", "legacy_id"] };

/** The rows of a batch as a record set read from one jsonb parameter ($1). */
const recordset = (columns: Columns) => `jsonb_to_recordset($1::jsonb) as r(${columns.map(([name, type]) => `${name} ${type}`).join(", ")})`;

function statements(target: Target) {
  const names = target.columns.map(([name]) => name);
  const compared = names.filter((name) => !target.key.includes(name));
  const tuple = (prefix: string) => `(${compared.map((name) => `${prefix}.${name}`).join(", ")})`;
  const keyMatch = target.key.map((name) => `t.${name} = r.${name}`).join(" and ");
  return {
    classify: `select count(*) filter (where t.id is null)::int as added,
                      count(*) filter (where t.id is not null and ${tuple("t")} is distinct from ${tuple("r")})::int as changed
               from ${recordset(target.columns)} left join ${target.table} t on ${keyMatch}`,
    upsert: `insert into ${target.table} (${names.join(", ")}, imported_at, updated_at)
             select ${names.map((name) => `r.${name}`).join(", ")}, $2::timestamptz, $2::timestamptz from ${recordset(target.columns)}
             on conflict (${target.key.join(", ")}) do update set ${compared.map((name) => `${name} = excluded.${name}`).join(", ")}, updated_at = excluded.updated_at
             where ${tuple(target.table)} is distinct from ${tuple("excluded")}`,
  };
}

const sqlOf = { trips: statements(TRIPS), exceptions: statements(EXCEPTIONS) };

function noteValues(counts: PartCounts, mapped: Mapped) {
  for (const column of mapped.notes.unparsed) bump(counts.unparsed, column);
  for (const column of mapped.notes.rounded) bump(counts.rounded, column);
}

async function writeBatch(context: PartContext, target: keyof typeof sqlOf, rows: Record<string, unknown>[], counts: PartCounts, after: number) {
  const json = JSON.stringify(rows);
  const { classify, upsert } = sqlOf[target];
  const step = async (runner: SqlRunner) => {
    const [found] = await runner.query<{ added: number; changed: number }>(classify, [json]);
    const added = Number(found?.added ?? 0);
    const changed = Number(found?.changed ?? 0);
    counts.added += added;
    counts.changed += changed;
    counts.unchanged += rows.length - added - changed;
  };
  if (context.dryRun) {
    await step(context.database);
    return;
  }
  await context.database.transaction(async (tx) => {
    await step(tx);
    if (rows.length > 0) await tx.query(upsert, [json, context.now().toISOString()]);
    await context.committed(tx, after);
  });
}

/** Pages through one reader list from `after`, mapping and writing each page. */
async function pages<T>(
  context: PartContext,
  target: keyof typeof sqlOf,
  after: number,
  read: (after: number) => Promise<T[]>,
  idOf: (item: T) => number,
  map: (item: T) => Mapped | null,
): Promise<PartCounts> {
  const counts = newCounts();
  let cursor = after;
  for (;;) {
    const batch = await read(cursor);
    if (batch.length === 0) break;
    counts.read += batch.length;
    const rows: Record<string, unknown>[] = [];
    for (const item of batch) {
      const mapped = map(item);
      if (!mapped) {
        bump(counts.skipped, "INVALID_ID");
        continue;
      }
      noteValues(counts, mapped);
      rows.push(mapped.row);
    }
    const last = idOf(batch[batch.length - 1] as T);
    cursor = Number.isFinite(last) && last > cursor ? last : cursor;
    await writeBatch(context, target, rows, counts, cursor);
    if (batch.length < context.batchSize) break;
  }
  return counts;
}

export function importTrips(context: PartContext, after: number): Promise<PartCounts> {
  return pages(
    context,
    "trips",
    after,
    (cursor) => context.reader.registrations(cursor, context.batchSize, context.since),
    (bundle) => Number(bundle.registration.id),
    mapRegistration,
  );
}

/**
 * Approvals first, then the reports no approval points to. A few thousand rows: a resumed run reads this part
 * again from the start instead of keeping a cursor for each of the two lists.
 */
export async function importExceptions(context: PartContext): Promise<PartCounts> {
  const quiet: PartContext = { ...context, committed: async () => {} };
  const approvals = await pages(
    quiet,
    "exceptions",
    0,
    (cursor) => context.reader.approvals(cursor, context.batchSize, context.since),
    (item) => Number(item.approval.id),
    mapApproval,
  );
  const reports = await pages(
    quiet,
    "exceptions",
    0,
    (cursor) => context.reader.reports(cursor, context.batchSize, context.since),
    (item) => Number(item.report.id),
    mapReport,
  );
  const merged = newCounts();
  for (const part of [approvals, reports]) {
    merged.read += part.read;
    merged.added += part.added;
    merged.changed += part.changed;
    merged.unchanged += part.unchanged;
    for (const key of ["skipped", "unparsed", "rounded", "notes"] as const) for (const [name, n] of Object.entries(part[key])) bump(merged[key], name, n);
  }
  return merged;
}
