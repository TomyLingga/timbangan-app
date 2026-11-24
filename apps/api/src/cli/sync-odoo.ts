// npm run sync:odoo [-- --full] — the same run as POST /api/admin/sync/odoo, from the shell.
// --full reads every contract instead of only those whose header changed, so delivered quantities posted in Odoo
// since the last run are taken too; `npm run cutover:opening` wants one less than an hour old.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { OdooClient } from "../odoo/client.js";
import { syncOdoo } from "../odoo/sync.js";

const USAGE = "Usage: npm run sync:odoo [-- --full]";

export async function runSyncOdoo(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
  args: string[] = [],
): Promise<number> {
  let database: Database | undefined;
  try {
    let full = false;
    try {
      full = parseArgs({ args, options: { full: { type: "boolean" } } }).values.full === true;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const config = loadConfig(env);
    if (!config.odoo) throw new Error("Odoo is not configured: set ODOO_URL, ODOO_DB, ODOO_UID and ODOO_PASSWORD.");
    database = await open(config.databaseUrl);
    const result = await syncOdoo(database, new OdooClient(config.odoo), () => new Date(), { tankParentLocationId: config.odooTankParentLocationId, full });
    print(
      `Odoo ${full ? "full " : ""}sync finished in ${result.durationMs} ms: ${result.contracts} contracts, ${result.partners} partners, ${result.products} products written; ${result.skipped} lines skipped.`,
    );
    print(
      result.tanks.status === "OK"
        ? `Tanks: ${result.tanks.written} written, ${result.tanks.deactivated} made inactive, ${result.tanks.skipped} skipped.`
        : "Tanks skipped: ODOO_TANK_PARENT_LOCATION_ID is not set.",
    );
    return 0;
  } catch (error) {
    print(`Odoo sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runSyncOdoo(process.env, console.log, createDb, process.argv.slice(2));
