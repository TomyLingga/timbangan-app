// npm run migrate — applies the SQL files in migrations/ that the database does not have yet.
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { migrate } from "../db/migrate.js";

export async function runMigrate(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
): Promise<number> {
  let database: Database | undefined;
  try {
    database = await open(loadConfig(env).databaseUrl);
    const { applied, skipped } = await migrate(database);
    print(
      applied.length > 0
        ? `Applied ${applied.length} migrations: ${applied.join(", ")}`
        : `Nothing to apply: ${skipped.length} migrations were applied before.`,
    );
    return 0;
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runMigrate(process.env, console.log);
