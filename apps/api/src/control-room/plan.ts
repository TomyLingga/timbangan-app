// The plant plan of the control room: the drawing (an SVG kept below the storage root, one per site) and the zone
// polygons (zones.map_shape). The drawing is put into the page's own document by the web app, so it is checked
// against a short list of plain drawing elements before it is stored: no scripts, no event attributes, no style
// sheets, no embedded HTML and no reference outside the file itself.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Database } from "../db/client.js";

export class PlanError extends Error {
  override name = "PlanError";
}

/** Largest drawing accepted, in bytes. A plan of lines stays far below this. */
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;

const ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc", "defs", "use", "symbol",
  "clippath", "mask", "pattern", "lineargradient", "radialgradient", "stop", "text", "tspan", "metadata",
]);

const TAG = /<\s*([A-Za-z][\w:.-]*)([^>]*)>/g;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;

/** What is wrong with the drawing; empty when it may be stored and shown. */
export function checkPlanSvg(text: string): string[] {
  const problems = new Set<string>();
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) problems.add(`the drawing is larger than ${MAX_PLAN_BYTES} bytes`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) problems.add("a document type or entity declaration");
  if (/<\?xml-stylesheet/i.test(text)) problems.add("a style sheet instruction");
  if (/<!\[CDATA\[/i.test(text)) problems.add("a CDATA section");
  // the first element after the prolog and comments is the svg root
  const body = text.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trimStart();
  if (!/^<svg[\s>]/.test(body)) problems.add("the file does not start with an <svg> element");
  else if (viewBoxOf(text) === null) problems.add("the <svg> element has no viewBox");

  for (const tag of body.matchAll(TAG)) {
    const name = (tag[1] ?? "").toLowerCase();
    if (!ELEMENTS.has(name.replace(/^svg:/, ""))) problems.add(`the element <${name}> is not allowed`);
    for (const attribute of (tag[2] ?? "").matchAll(ATTRIBUTE)) {
      const key = (attribute[1] ?? "").toLowerCase();
      const value = (attribute[3] ?? attribute[4] ?? attribute[5] ?? "").trim();
      if (/^on/.test(key)) problems.add(`an event attribute (${key})`);
      if ((key === "href" || key.endsWith(":href")) && !value.startsWith("#")) problems.add("a link outside the drawing");
      if (/url\s*\(\s*(?!['"]?#)/i.test(value)) problems.add("a url() outside the drawing");
      if (/javascript:|data:|@import/i.test(value)) problems.add("a script, data or import reference");
    }
  }
  return [...problems];
}

/** [width, height] of the root element's viewBox "0 0 w h"; null when absent or not starting at 0 0. */
export function viewBoxOf(text: string): [number, number] | null {
  const root = /<svg\b([^>]*)>/.exec(text);
  const match = root ? /\bviewBox\s*=\s*["']\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/.exec(root[1] ?? "") : null;
  if (!match) return null;
  const [minX, minY, width, height] = match.slice(1, 5).map(Number);
  if (minX !== 0 || minY !== 0 || !(width! > 0) || !(height! > 0)) return null;
  return [width!, height!];
}

const SITE_CODE = /^[A-Z0-9_-]{1,20}$/;

/** Where the drawing of a site is kept. */
export function planFilePath(filesDir: string, siteCode: string): string {
  if (!SITE_CODE.test(siteCode)) throw new PlanError(`Site code ${siteCode} is not valid.`);
  return join(filesDir, "control-room", `plan-${siteCode}.svg`);
}

/** The stored drawing of the site, or null when none was imported. */
export async function readPlanSvg(filesDir: string, siteCode: string): Promise<string | null> {
  try {
    return await readFile(planFilePath(filesDir, siteCode), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function hasPlanSvg(filesDir: string, siteCode: string): Promise<boolean> {
  try {
    await access(planFilePath(filesDir, siteCode));
    return true;
  } catch {
    return false;
  }
}

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const planInput = z.object({
  site: z.string().min(1),
  viewBox: z.tuple([z.number().positive(), z.number().positive()]),
  zones: z.record(z.string(), z.array(point).min(3).max(200)),
});
export type PlanInput = z.infer<typeof planInput>;

export interface PlanImportResult {
  site: string;
  /** Zones named in the input. */
  zones: number;
  /** Of those, the ones whose shape was different and was written. */
  changed: number;
  unchanged: number;
  svgBytes: number;
  /** False when the stored drawing was already the same and was left alone. */
  svgChanged: boolean;
}

/**
 * Stores the zone polygons and the drawing of one site. Everything is checked before anything is written; running it
 * again with the same input changes nothing. Zones the input does not name keep their shape.
 */
export async function importPlan(database: Database, filesDir: string, raw: unknown, svgText: string): Promise<PlanImportResult> {
  const parsed = planInput.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new PlanError(`The plan file is not valid at: ${[...new Set(where)].join(", ")}.`);
  }
  const input = parsed.data;
  const problems = checkPlanSvg(svgText);
  if (problems.length) throw new PlanError(`The drawing was refused: ${problems.join("; ")}.`);
  const viewBox = viewBoxOf(svgText);
  if (!viewBox || viewBox[0] !== input.viewBox[0] || viewBox[1] !== input.viewBox[1]) {
    throw new PlanError(`The viewBox of the plan file (${input.viewBox.join(" x ")}) differs from the drawing (${viewBox ? viewBox.join(" x ") : "none"}).`);
  }
  const path = planFilePath(filesDir, input.site);

  return database.transaction(async (tx) => {
    const [site] = await tx.query<{ id: number }>("select id from sites where code = $1", [input.site]);
    if (!site) throw new PlanError(`Site ${input.site} does not exist.`);
    const known = new Map((await tx.query<{ id: number; code: string }>("select id, code from zones where site_id = $1", [site.id])).map((row) => [row.code, Number(row.id)]));
    const unknown = Object.keys(input.zones).filter((code) => !known.has(code));
    if (unknown.length) throw new PlanError(`Unknown zone codes for site ${input.site}: ${unknown.join(", ")}.`);

    let changed = 0;
    for (const [code, points] of Object.entries(input.zones)) {
      const rows = await tx.query("update zones set map_shape = $2::jsonb where id = $1 and map_shape is distinct from $2::jsonb returning id", [
        known.get(code),
        JSON.stringify(points),
      ]);
      changed += rows.length;
    }

    const before = await readPlanSvg(filesDir, input.site);
    const svgChanged = before !== svgText;
    if (svgChanged) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, svgText, "utf8");
    }
    const zones = Object.keys(input.zones).length;
    return { site: input.site, zones, changed, unchanged: zones - changed, svgBytes: Buffer.byteLength(svgText), svgChanged };
  });
}
