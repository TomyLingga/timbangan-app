// One run of `npm run legacy:import`: the archive parts and the masters, in a fixed order, each optional. A run that
// writes is recorded in legacy_import_runs with its options, its counts and, after every committed batch, how far
// each part got; `resume` continues the newest run that did not finish. A dry run reads and counts, writes nothing
// and records nothing.
import { importExceptions, importTrips } from "./archive.js";
import { ENTITIES, type Entity, ImportError, type PartContext, type PartCounts } from "./counts.js";
import { importCards, importSeals, importVehicles } from "./masters.js";
import type { LegacyReader } from "./reader.js";

export { ENTITIES, type Entity, ImportError, type PartCounts };

export const BATCH_SIZE = 2_000;

export interface ImportOptions {
  dryRun?: boolean;
  /** YYYY-MM-DD: only registrations entered (approvals requested, reports made) on or after it. */
  since?: string | null;
  /** The parts to run; all when absent. */
  only?: Entity[];
  /** Continue the newest run that stopped, after the last batch it committed. */
  resume?: boolean;
  batchSize?: number;
}

export interface ImportResult {
  /** The legacy_import_runs row; null on a dry run. */
  runId: number | null;
  dryRun: boolean;
  /** The run that was continued. */
  resumedFrom: number | null;
  /** Parts the continued run had finished, not run again. */
  alreadyDone: Entity[];
  parts: Partial<Record<Entity, PartCounts>>;
  durationMs: number;
}

type Progress = Partial<Record<Entity, { after: number; done: boolean }>>;

const RUNNERS: Record<Entity, (context: PartContext, after: number) => Promise<PartCounts>> = {
  trips: importTrips,
  exceptions: (context) => importExceptions(context),
  vehicles: (context) => importVehicles(context),
  seals: importSeals,
  cards: (context) => importCards(context),
};

export async function importLegacy(database: PartContext["database"], reader: LegacyReader, options: ImportOptions, now: () => Date): Promise<ImportResult> {
  const started = performance.now();
  const dryRun = options.dryRun === true;
  const wanted = new Set(options.only ?? ENTITIES);
  const entities = ENTITIES.filter((entity) => wanted.has(entity));

  let start: Progress = {};
  let resumedFrom: number | null = null;
  if (options.resume) {
    const [stopped] = await database.query<{ id: number; progress: Progress }>(
      "select id::int as id, progress from legacy_import_runs where status in ('FAILED', 'RUNNING') order by id desc limit 1",
    );
    if (!stopped) throw new ImportError("Tidak ada impor yang terhenti untuk dilanjutkan.");
    start = stopped.progress ?? {};
    resumedFrom = stopped.id;
  }

  let runId: number | null = null;
  if (!dryRun) {
    const [run] = await database.query<{ id: number }>(
      "insert into legacy_import_runs (started_at, options) values ($1::timestamptz, $2::jsonb) returning id::int as id",
      [now().toISOString(), JSON.stringify({ only: entities, since: options.since ?? null, resume: options.resume === true })],
    );
    runId = Number(run?.id);
  }

  const parts: Partial<Record<Entity, PartCounts>> = {};
  const alreadyDone: Entity[] = [];
  try {
    for (const entity of entities) {
      if (start[entity]?.done) {
        alreadyDone.push(entity);
        continue;
      }
      const context: PartContext = {
        database,
        reader,
        dryRun,
        since: options.since ?? null,
        batchSize: options.batchSize ?? BATCH_SIZE,
        now,
        committed: async (tx, after) => {
          await tx.query("update legacy_import_runs set progress = progress || $2::jsonb where id = $1", [runId, JSON.stringify({ [entity]: { after, done: false } })]);
        },
      };
      parts[entity] = await RUNNERS[entity](context, start[entity]?.after ?? 0);
      if (runId !== null) {
        await database.query("update legacy_import_runs set progress = progress || $2::jsonb where id = $1", [runId, JSON.stringify({ [entity]: { after: 0, done: true } })]);
      }
    }
  } catch (error) {
    if (runId !== null) {
      await database.query("update legacy_import_runs set status = 'FAILED', finished_at = $2::timestamptz, counts = $3::jsonb, error = $4 where id = $1", [
        runId,
        now().toISOString(),
        JSON.stringify(parts),
        error instanceof Error ? error.message : String(error),
      ]);
    }
    throw error;
  }
  if (runId !== null) {
    await database.query("update legacy_import_runs set status = 'OK', finished_at = $2::timestamptz, counts = $3::jsonb where id = $1", [
      runId,
      now().toISOString(),
      JSON.stringify(parts),
    ]);
  }
  return { runId, dryRun, resumedFrom, alreadyDone, parts, durationMs: Math.round(performance.now() - started) };
}
