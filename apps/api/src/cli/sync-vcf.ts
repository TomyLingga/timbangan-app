// npm run sync:vcf — the same run as POST /api/admin/sync/vcf, from the shell.
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { VcfClient } from "../vcf/client.js";
import { syncVcf } from "../vcf/sync.js";

export async function runSyncVcf(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
): Promise<number> {
  let database: Database | undefined;
  try {
    const config = loadConfig(env);
    if (!config.vcf) throw new Error("The driver registry is not configured: set VCF_URL.");
    database = await open(config.databaseUrl);
    const result = await syncVcf(database, new VcfClient(config.vcf.url), () => new Date());
    print(
      `Driver registry sync finished in ${result.durationMs} ms: ${result.drivers} drivers, ${result.transporters} transporters written; ${result.skipped} rows skipped.`,
    );
    return 0;
  } catch (error) {
    print(`Driver registry sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runSyncVcf(process.env, console.log);
