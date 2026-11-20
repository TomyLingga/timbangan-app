import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./client.js";

/** `apps/api/migrations`, two levels above this file both in `src/db` and in `dist/db`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Line endings are normalised first, so a CRLF checkout on Windows does not look like an edited file. */
function checksumOf(text: string): string {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
}

/**
 * Applies `*.sql` in file-name order, each file in one transaction, and records it in `schema_migrations`.
 * A file that was applied before is skipped; if its content changed since, the run stops with an error.
 */
export async function migrate(database: Database, options: { dir?: string } = {}): Promise<MigrationResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

  const [existing] = await database.query<{ found: string | null }>("select to_regclass('public.schema_migrations')::text as found");
  if (!existing?.found) {
    await database.script(
      "create table schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
  }
  const recorded = new Map(
    (await database.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).map((row) => [row.name, row.checksum]),
  );

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const name of names) {
    const text = await readFile(join(dir, name), "utf8");
    const checksum = checksumOf(text);
    const known = recorded.get(name);
    if (known !== undefined) {
      if (known !== checksum) {
        throw new Error(`Migration ${name} was changed after it was applied. Restore the file and put the change in a new migration.`);
      }
      result.skipped.push(name);
      continue;
    }
    try {
      await database.transaction(async (tx) => {
        await tx.script(text);
        await tx.query("insert into schema_migrations (name, checksum) values ($1, $2)", [name, checksum]);
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    result.applied.push(name);
  }
  return result;
}
