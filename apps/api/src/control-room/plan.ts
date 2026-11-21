// The plant plan of the control room: the drawing (an SVG kept below the storage root, one per site) and the zone
// polygons (zones.map_shape). The drawing is put into the page's own document by the web app, so it is checked
// against a short list of plain drawing elements before it is stored: no scripts, no event attributes, no style
// sheets, no embedded HTML and no reference outside the file itself.
//
// A site may also have a picture of the plan (the owner's own layout drawing, PNG or JPEG). The page shows it as the
// base layer under the zones, so the zone fractions refer to the picture as well; it must have the shape of the
// viewBox. It is only ever served as an image with nosniff, never put into the page's document.
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Largest plan picture accepted, in bytes. */
export const MAX_PLAN_IMAGE_BYTES = 8 * 1024 * 1024;

export type PlanImageFormat = "png" | "jpeg";

export interface PlanImageSize {
  format: PlanImageFormat;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The size of a JPEG from its first frame header (SOF0 to SOF15 except DHT, JPG and DAC); null when there is none. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // fill bytes and markers without a length
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/** Format and pixel size of a plan picture, from its first bytes. Anything but a PNG or a JPEG is refused. */
export function checkPlanImage(bytes: Buffer): PlanImageSize {
  if (bytes.length > MAX_PLAN_IMAGE_BYTES) throw new PlanError("The plan image is larger than 8 MB.");
  let found: PlanImageSize | null = null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString("ascii", 12, 16) === "IHDR") {
    found = { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    if (!size) throw new PlanError("The plan image is a JPEG without a readable size.");
    found = { format: "jpeg", ...size };
  }
  if (!found) throw new PlanError("The plan image must be a PNG or JPEG file.");
  if (!(found.width > 0 && found.height > 0 && found.width <= 20_000 && found.height <= 20_000)) {
    throw new PlanError(`The plan image has an unusable size (${found.width} x ${found.height}).`);
  }
  return found;
}

const IMAGE_EXTENSION: Record<PlanImageFormat, string> = { png: "png", jpeg: "jpg" };
export const PLAN_IMAGE_TYPE: Record<PlanImageFormat, string> = { png: "image/png", jpeg: "image/jpeg" };

/** What is kept next to the picture: its format, size and a hash of its bytes. */
export interface PlanImageInfo extends PlanImageSize {
  bytes: number;
  /** The first 16 hex digits of the SHA-256 of the picture; changes when another picture is imported. */
  version: string;
}

const imageInfoPath = (filesDir: string, siteCode: string) => planFilePath(filesDir, siteCode).replace(/\.svg$/, "-image.json");
/** Where the picture of a site is kept, by format. */
export const planImagePath = (filesDir: string, siteCode: string, format: PlanImageFormat) =>
  planFilePath(filesDir, siteCode).replace(/\.svg$/, `-image.${IMAGE_EXTENSION[format]}`);

/** The stored picture's description, or null when the site has none. */
export async function readPlanImageInfo(filesDir: string, siteCode: string): Promise<PlanImageInfo | null> {
  try {
    const info = JSON.parse(await readFile(imageInfoPath(filesDir, siteCode), "utf8")) as PlanImageInfo;
    return info.format in IMAGE_EXTENSION ? info : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removePlanImage(filesDir: string, siteCode: string): Promise<boolean> {
  const before = await readPlanImageInfo(filesDir, siteCode);
  await rm(imageInfoPath(filesDir, siteCode), { force: true });
  for (const format of Object.keys(IMAGE_EXTENSION) as PlanImageFormat[]) await rm(planImagePath(filesDir, siteCode, format), { force: true });
  return before !== null;
}

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const planInput = z.object({
  site: z.string().min(1),
  viewBox: z.tuple([z.number().positive(), z.number().positive()]),
  zones: z.record(z.string(), z.array(point).min(3).max(200)),
  /** Path of the plan picture (read by the caller); null removes the stored one, absent leaves it as it is. */
  image: z.string().min(1).nullable().optional(),
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
  /** Null when the plan file does not name a picture. */
  image: (PlanImageSize & { bytes: number; status: "written" | "unchanged" }) | { status: "removed" | "none" } | null;
}

/**
 * Stores the zone polygons, the drawing and the picture of one site. Everything is checked before anything is
 * written; running it again with the same input changes nothing. Zones the input does not name keep their shape, and
 * a picture the input does not name stays as it is (`"image": null` removes it).
 */
export async function importPlan(database: Database, filesDir: string, raw: unknown, svgText: string, imageBytes?: Buffer): Promise<PlanImportResult> {
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
  let picture: PlanImageSize | null = null;
  if (typeof input.image === "string") {
    if (!imageBytes) throw new PlanError("The plan file names an image, but no image was given.");
    picture = checkPlanImage(imageBytes);
    const want = input.viewBox[0] / input.viewBox[1];
    const have = picture.width / picture.height;
    if (Math.abs(have - want) / want > 0.01) {
      throw new PlanError(`The plan image (${picture.width} x ${picture.height}) does not have the shape of the viewBox (${input.viewBox.join(" x ")}).`);
    }
  }

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
    let image: PlanImportResult["image"] = null;
    if (picture && imageBytes) {
      const version = createHash("sha256").update(imageBytes).digest("hex").slice(0, 16);
      const before = await readPlanImageInfo(filesDir, input.site);
      const same = before?.version === version && before.format === picture.format;
      if (!same) {
        await removePlanImage(filesDir, input.site);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(planImagePath(filesDir, input.site, picture.format), imageBytes);
        const info: PlanImageInfo = { ...picture, bytes: imageBytes.length, version };
        await writeFile(imageInfoPath(filesDir, input.site), JSON.stringify(info), "utf8");
      }
      image = { ...picture, bytes: imageBytes.length, status: same ? "unchanged" : "written" };
    } else if (input.image === null) {
      image = { status: (await removePlanImage(filesDir, input.site)) ? "removed" : "none" };
    }
    const zones = Object.keys(input.zones).length;
    return { site: input.site, zones, changed, unchanged: zones - changed, svgBytes: Buffer.byteLength(svgText), svgChanged, image };
  });
}
