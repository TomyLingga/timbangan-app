// npm run legacy:import -- [--dry-run] [--since=YYYY-MM-DD] [--only=trips,exceptions,vehicles,seals,cards] [--resume]
// Copies the old weighbridge application's history into the archive tables and its truck, seal and card masters
// into the working tables. The old database (LEGACY_DATABASE_URL) is opened read only. Prints counts only, never
// the content of a row.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { ENTITIES, type Entity, ImportError, type ImportResult, importLegacy, type PartCounts } from "../legacy/import.js";
import { type LegacyReader, PostgresLegacyReader } from "../legacy/reader.js";

const USAGE = "Pemakaian: npm run legacy:import -- [--dry-run] [--since=YYYY-MM-DD] [--only=trips,exceptions,vehicles,seals,cards] [--resume]";

export interface LegacyImportDeps {
  open?: (url: string) => Promise<Database>;
  openReader?: (url: string) => LegacyReader;
  now?: () => Date;
}

const LABELS: Record<Entity, string> = {
  trips: "registrasi lama",
  exceptions: "persetujuan dan BA",
  vehicles: "master truk",
  seals: "stok segel",
  cards: "kartu RFID",
};
const REASONS: Record<string, string> = {
  INVALID_ID: "id tidak sah",
  EXISTS: "sudah ada",
  DUPLICATE_IN_SOURCE: "ganda di data lama",
  INVALID_PLATE: "plat tidak sah",
  EMPTY_NUMBER: "nomor kosong",
  NOT_10_CHARACTERS: "bukan 10 karakter",
  NOT_HEXADECIMAL: "bukan heksadesimal",
};

const list = (counter: Record<string, number>, label: (key: string) => string = (key) => key) =>
  Object.entries(counter)
    .map(([key, n]) => `${label(key)} ${n}`)
    .join(", ");
const total = (counter: Record<string, number>) => Object.values(counter).reduce((sum, n) => sum + n, 0);

function partLines(entity: Entity, counts: PartCounts): string[] {
  const skipped = total(counts.skipped);
  const head = `${entity}: dibaca ${counts.read}, baru ${counts.added}, berubah ${counts.changed}, sama ${counts.unchanged}, dilewati ${skipped}`;
  const lines = [`${head}${skipped > 0 ? ` (${list(counts.skipped, (key) => REASONS[key] ?? key)})` : ""}  [${LABELS[entity]}]`];
  if (total(counts.unparsed) > 0) lines.push(`  nilai tak terbaca, disimpan teks aslinya: ${list(counts.unparsed)}`);
  if (total(counts.rounded) > 0) lines.push(`  berat berkoma dibulatkan ke kg: ${list(counts.rounded)}`);
  if (counts.notes.TYPE_FALLBACK) lines.push(`  jenis truk tidak dikenal, dicatat sebagai TANGKI: ${counts.notes.TYPE_FALLBACK}`);
  return lines;
}

export function reportLines(result: ImportResult): string[] {
  const lines = [result.dryRun ? "Uji coba: data lama dibaca dan dihitung, tidak ada yang ditulis." : `Impor data lama, catatan impor #${result.runId}.`];
  if (result.resumedFrom !== null) lines.push(`Melanjutkan impor #${result.resumedFrom}.${result.alreadyDone.length > 0 ? ` Sudah selesai di sana: ${result.alreadyDone.join(", ")}.` : ""}`);
  for (const entity of ENTITIES) {
    const counts = result.parts[entity];
    if (counts) lines.push(...partLines(entity, counts));
  }
  const written = Object.values(result.parts).reduce((sum, counts) => sum + counts.added + counts.changed, 0);
  if (!result.dryRun && written === 0) lines.push("Tidak ada perubahan: semua baris sudah sama dengan impor sebelumnya.");
  lines.push(`Selesai dalam ${result.durationMs} ms.`);
  return lines;
}

export async function runLegacyImport(args: string[], env: Record<string, string | undefined>, print: (line: string) => void, deps: LegacyImportDeps = {}): Promise<number> {
  let database: Database | undefined;
  let reader: LegacyReader | undefined;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, options: { "dry-run": { type: "boolean" }, since: { type: "string" }, only: { type: "string" }, resume: { type: "boolean" } } }));
    } catch (error) {
      throw new ImportError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const since = values.since ?? null;
    if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new ImportError(`--since harus berformat YYYY-MM-DD.\n${USAGE}`);
    let only: Entity[] | undefined;
    if (values.only !== undefined) {
      const named = values.only.split(",").map((part) => part.trim()).filter(Boolean);
      const unknown = named.filter((part) => !(ENTITIES as readonly string[]).includes(part));
      if (named.length === 0 || unknown.length > 0) throw new ImportError(`--only hanya menerima ${ENTITIES.join(", ")}.\n${USAGE}`);
      only = named as Entity[];
    }
    const config = loadConfig(env);
    if (!config.legacyDatabaseUrl) throw new ImportError("LEGACY_DATABASE_URL belum diisi di .env: alamat database aplikasi lama.");

    database = await (deps.open ?? createDb)(config.databaseUrl);
    reader = (deps.openReader ?? ((url: string) => PostgresLegacyReader.open(url)))(config.legacyDatabaseUrl);
    const result = await importLegacy(database, reader, { dryRun: values["dry-run"] === true, since, only, resume: values.resume === true }, deps.now ?? (() => new Date()));
    for (const line of reportLines(result)) print(line);
    return 0;
  } catch (error) {
    // the message only: a database error keeps the values of the failing row in its detail, which is not printed
    print(`Impor berhenti: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await reader?.close();
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runLegacyImport(process.argv.slice(2), process.env, console.log);
