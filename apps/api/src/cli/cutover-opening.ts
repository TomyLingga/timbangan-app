// npm run cutover:opening -- [--dry-run] [--again] [--stale-ok]
// On the cut-over day, after the last truck of the old application left, `npm run legacy:import` and
// `npm run sync:odoo -- --full`: sets erp_contracts.qty_opening of every contract line once (incoming from the
// archive, outgoing from Odoo; see legacy/cutover.ts). A second run is refused unless --again is given; a run
// without a full Odoo sync of the last hour is refused unless --stale-ok is given. Prints counts and summed
// quantities only, never a contract number.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { type CutoverResult, cutoverOpening } from "../legacy/cutover.js";

const USAGE = "Pemakaian: npm run cutover:opening -- [--dry-run] [--again] [--stale-ok]";

export function cutoverLines(result: CutoverResult): string[] {
  const { incoming: i, outgoing: o } = result;
  const lines = [result.dryRun ? "Uji coba: tidak ada yang diubah." : "Saldo awal kontrak diisi."];
  if (result.previous !== null) lines.push(`Pengisian sebelumnya: ${result.previous}.`);
  if (result.staleWarning !== null) lines.push(`Perhatian: ${result.staleWarning}`);
  const total = (direction: string) => result.totals.filter((row) => row.direction === direction).map((row) => `  ${row.direction} ${row.uom}: ${row.qty}`);
  lines.push(`IN: ${i.lines} baris kontrak; ${i.set} diisi dari arsip, ${i.zero} tetap nol karena tidak ada yang cocok, ${i.notKg} bukan kg dilewati.`);
  lines.push(`  truk arsip dengan netto nol, negatif, atau kosong, tidak dihitung: ${i.leftOutTrips}`);
  lines.push(`  truk arsip yang tidak bisa dibagi ke baris kontrak: ${i.unattributedTrips} (${round(i.unattributedKg)} kg)`);
  lines.push(`  referensi arsip tanpa kontrak: ${i.unmatchedReferences} referensi, ${i.unmatchedTrips} truk`);
  lines.push(...total("IN"));
  lines.push(`OUT: ${o.lines} baris kontrak; ${o.set} diisi dari Odoo, ${o.withoutErp} tanpa angka Odoo dibiarkan.`);
  lines.push(...total("OUT"));
  lines.push(`${result.changed} baris ${result.dryRun ? "akan berubah" : "berubah"}.`);
  return lines;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export async function runCutoverOpening(
  args: string[],
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
  now: () => Date = () => new Date(),
): Promise<number> {
  let database: Database | undefined;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, options: { "dry-run": { type: "boolean" }, again: { type: "boolean" }, "stale-ok": { type: "boolean" } } }));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    database = await open(loadConfig(env).databaseUrl);
    const result = await cutoverOpening(database, { dryRun: values["dry-run"] === true, again: values.again === true, staleOk: values["stale-ok"] === true }, now);
    for (const line of cutoverLines(result)) print(line);
    return 0;
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runCutoverOpening(process.argv.slice(2), process.env, console.log);
