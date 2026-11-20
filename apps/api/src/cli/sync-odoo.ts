// npm run sync:odoo — the same run as POST /api/admin/sync/odoo, from the shell.
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { OdooClient } from "../odoo/client.js";
import { syncOdoo } from "../odoo/sync.js";

export async function runSyncOdoo(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
): Promise<number> {
  let database: Database | undefined;
  try {
    const config = loadConfig(env);
    if (!config.odoo) throw new Error("Odoo is not configured: set ODOO_URL, ODOO_DB, ODOO_UID and ODOO_PASSWORD.");
    database = await open(config.databaseUrl);
    const result = await syncOdoo(database, new OdooClient(config.odoo), () => new Date());
    print(
      `Odoo sync finished in ${result.durationMs} ms: ${result.contracts} contracts, ${result.partners} partners, ${result.products} products written; ${result.skipped} lines skipped.`,
    );
    return 0;
  } catch (error) {
    print(`Odoo sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runSyncOdoo(process.env, console.log);
