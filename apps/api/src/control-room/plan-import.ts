// npm run plan:import -- <plan.json>
//
// Loads the plant plan of one site from local files that stay out of git:
//   { "site": "<code>", "viewBox": [w, h], "svg": "<path of the drawing, relative to the JSON file>",
//     "zones": { "REG": [[x, y], ...], ... } }   (polygon points as fractions of the plan's width and height)
// The drawing is checked and copied below FILE_STORAGE_DIR; the polygons go to zones.map_shape. Only counts are
// printed, never the paths or the figures, so the output can be pasted anywhere.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "../db/client.js";
import { importPlan } from "./plan.js";

export async function runPlanImport(
  env: Record<string, string | undefined>,
  args: string[],
  print: (line: string) => void,
  open: (url: string) => Promise<Database> = createDb,
): Promise<number> {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) {
    print("Usage: npm run plan:import -- <plan.json>");
    return 1;
  }
  let database: Database | undefined;
  try {
    const config = loadConfig(env);
    const raw = JSON.parse(await readFile(file, "utf8")) as { svg?: unknown };
    if (typeof raw.svg !== "string" || !raw.svg) throw new Error('The plan file has no "svg" path.');
    const svgText = await readFile(resolve(dirname(file), raw.svg), "utf8");
    database = await open(config.databaseUrl);
    const result = await importPlan(database, config.files.dir, raw, svgText);
    print(
      `Plan imported for site ${result.site}: ${result.zones} zones (${result.changed} changed, ${result.unchanged} unchanged); ` +
        `drawing ${result.svgBytes} bytes, ${result.svgChanged ? "written" : "unchanged"}.`,
    );
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // a missing file is reported without its path
    print(`Plan import failed: ${code === "ENOENT" ? "a file named in the command or the plan file does not exist." : error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await runPlanImport(process.env, process.argv.slice(2), console.log);
