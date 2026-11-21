// The plant plan: `npm run plan:import` writes the zone polygons and keeps the drawing below the storage root; the
// drawing is checked first, because the web page puts it into its own document.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEMO_PLAN_SVG, DEMO_ZONE_SHAPES } from "../src/control-room/demo-plan.js";
import { checkPlanImage, checkPlanSvg, importPlan, MAX_PLAN_IMAGE_BYTES, planFilePath } from "../src/control-room/plan.js";
import { runPlanImport } from "../src/control-room/plan-import.js";
import { testApp, TEST_JWT_SECRET } from "./helpers/app.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g fill="none" stroke="currentColor"><rect x="1" y="1" width="198" height="98"/><path d="M10 50 H190"/></g></svg>';
const square = (x: number, y: number) => [[x, y], [x + 0.05, y], [x + 0.05, y + 0.05], [x, y + 0.05]];
const ALL_ZONES = Object.fromEntries(["REG", "QUEUE", "WB", "QC", "STAGING", "DOCK", "LOADING", "UNLOADING", "SEAL"].map((code, index) => [code, square(index * 0.1, 0.5)]));
// unknown on purpose: the import checks the shape itself
const input = (overrides: Partial<Record<"site" | "viewBox" | "zones" | "image", unknown>> = {}): unknown => ({ site: "SMK", viewBox: [200, 100], zones: ALL_ZONES, ...overrides });

/** A real PNG of one grey colour; only its header matters to the import. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // greyscale
  const rows = Buffer.alloc((width + 1) * height, 0xcc);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0; // filter byte
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** The start of a baseline JPEG up to its frame header, which holds the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const shapes = async (database: Awaited<ReturnType<typeof testApp>>["database"]) =>
  Object.fromEntries(
    (await database.query<{ code: string; shape: string | null }>("select code, map_shape::text as shape from zones order by sort_order")).map((row) => [
      row.code,
      row.shape === null ? null : JSON.parse(row.shape),
    ]),
  );

describe("checkPlanSvg", () => {
  it("accepts a plain drawing", () => {
    expect(checkPlanSvg(SVG)).toEqual([]);
    expect(checkPlanSvg(DEMO_PLAN_SVG)).toEqual([]);
    expect(checkPlanSvg(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n${SVG}`)).toEqual([]);
  });

  it.each([
    ["a script", '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ["an event attribute", '<svg viewBox="0 0 1 1"><rect onload="alert(1)"/></svg>'],
    ["an event attribute without quotes", "<svg viewBox='0 0 1 1'><rect onclick=alert(1) /></svg>"],
    ["an external link", '<svg viewBox="0 0 1 1"><use href="https://example.invalid/x.svg#a"/></svg>'],
    ["an external xlink", '<svg viewBox="0 0 1 1"><image xlink:href="//example.invalid/a.png"/></svg>'],
    ["a data link", '<svg viewBox="0 0 1 1"><use href="data:image/svg+xml;base64,AAAA"/></svg>'],
    ["a javascript link", '<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><rect/></a></svg>'],
    ["an external url() in a style", '<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.invalid/p)"/></svg>'],
    ["a style sheet", '<svg viewBox="0 0 1 1"><style>@import url(x.css);</style></svg>'],
    ["embedded HTML", '<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>'],
    ["a document type", '<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>'],
    ["not an SVG", "<html><body/></html>"],
  ])("refuses %s", (_name, text) => {
    expect(checkPlanSvg(text).length).toBeGreaterThan(0);
  });
});

describe("importPlan", () => {
  async function setup() {
    const ctx = await testApp();
    return { ...ctx, filesDir: ctx.config.files.dir };
  }

  it("writes the zone polygons and keeps the drawing below the storage root, which the plan route then serves", async () => {
    const { app, database, filesDir } = await setup();
    const result = await importPlan(database, filesDir, input(), SVG);
    expect(result).toEqual({ site: "SMK", zones: 9, changed: 9, unchanged: 0, svgBytes: Buffer.byteLength(SVG), svgChanged: true, image: null });
    expect((await shapes(database)).QC).toEqual(ALL_ZONES.QC);
    expect(await readFile(planFilePath(filesDir, "SMK"), "utf8")).toBe(SVG);

    await seedStaff(database, "kontrol", { dashboard: "VIEW" });
    const response = await app.inject({ method: "GET", url: "/api/control-room/plan.svg", headers: await bearer(app, "kontrol") });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SVG);
    const state = await app.inject({ method: "GET", url: "/api/control-room/state", headers: await bearer(app, "kontrol") });
    expect(state.json().zones.find((zone: { code: string }) => zone.code === "SEAL").shape).toEqual(ALL_ZONES.SEAL);
  });

  it("changes nothing when the same plan is imported again, and only what differs otherwise", async () => {
    const { database, filesDir } = await setup();
    await importPlan(database, filesDir, input(), SVG);
    const before = (await stat(planFilePath(filesDir, "SMK"))).mtimeMs;
    expect(await importPlan(database, filesDir, input(), SVG)).toMatchObject({ zones: 9, changed: 0, unchanged: 9, svgChanged: false });
    expect((await stat(planFilePath(filesDir, "SMK"))).mtimeMs).toBe(before);
    expect(await importPlan(database, filesDir, input({ zones: { WB: square(0.6, 0.6) } }), SVG)).toMatchObject({ zones: 1, changed: 1, unchanged: 0 });
    expect((await shapes(database)).REG).toEqual(square(0, 0.5));
  });

  it.each([
    ["an unknown zone code", input({ zones: { ...ALL_ZONES, GUDANG: square(0, 0) } }), /GUDANG/],
    ["an unknown site", input({ site: "XYZ" }), /XYZ/],
    ["a polygon with two points", input({ zones: { WB: [[0, 0], [1, 1]] } }), /WB/],
    ["a point outside the plan", input({ zones: { WB: [[0, 0], [1.2, 0], [1, 1]] } }), /WB/],
    ["a viewBox that differs from the drawing", input({ viewBox: [300, 100] }), /viewBox/],
  ])("refuses %s and writes nothing", async (_name, plan, message) => {
    const { database, filesDir } = await setup();
    await expect(importPlan(database, filesDir, plan, SVG)).rejects.toThrow(message);
    expect(Object.values(await shapes(database)).every((shape) => shape === null)).toBe(true);
    await expect(stat(planFilePath(filesDir, "SMK"))).rejects.toThrow();
  });

  it("refuses an unsafe drawing and writes nothing", async () => {
    const { database, filesDir } = await setup();
    await expect(importPlan(database, filesDir, input(), SVG.replace("<g ", '<g onload="x()" '))).rejects.toThrow(/event attribute/);
    expect((await shapes(database)).REG).toBeNull();
  });
});

describe("npm run plan:import", () => {
  it("reads the JSON file and the drawing it names, and prints counts only", async () => {
    const ctx = await testApp();
    const folder = await mkdtemp(join(tmpdir(), "tr-plan-"));
    onTestFinished(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, "plan.svg"), SVG);
    await writeFile(join(folder, "plan.json"), JSON.stringify({ site: "SMK", viewBox: [200, 100], svg: "plan.svg", zones: ALL_ZONES }));
    const lines: string[] = [];
    const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, FILE_STORAGE_DIR: ctx.config.files.dir };
    const code = await runPlanImport(env, [join(folder, "plan.json")], (line) => lines.push(line), async () => ({ ...ctx.database, close: async () => {} }));
    expect(code).toBe(0);
    expect(lines).toEqual([`Plan imported for site SMK: 9 zones (9 changed, 0 unchanged); drawing ${Buffer.byteLength(SVG)} bytes, written.`]);
    expect(lines.join("\n")).not.toContain(folder);

    const failed: string[] = [];
    expect(await runPlanImport(env, [], (line) => failed.push(line), async () => ctx.database)).toBe(1);
    expect(failed[0]).toMatch(/Usage/);
  });
});

describe("the demo plan", () => {
  it("has a shape for every zone, inside the plan", () => {
    expect(Object.keys(DEMO_ZONE_SHAPES).sort()).toEqual(["DOCK", "LOADING", "QC", "QUEUE", "REG", "SEAL", "STAGING", "UNLOADING", "WB"]);
    for (const points of Object.values(DEMO_ZONE_SHAPES)) for (const [x = -1, y = -1] of points) expect(x >= 0 && x <= 1 && y >= 0 && y <= 1).toBe(true);
  });
});

describe("checkPlanImage", () => {
  it("reads the format and the pixel size from the first bytes of a PNG or a JPEG", () => {
    expect(checkPlanImage(png(200, 100))).toEqual({ format: "png", width: 200, height: 100 });
    expect(checkPlanImage(jpeg(916, 506))).toEqual({ format: "jpeg", width: 916, height: 506 });
  });

  it.each([
    ["an SVG", Buffer.from(SVG)],
    ["a GIF", Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])],
    ["an HTML page named .png", Buffer.from("<html><script>alert(1)</script></html>")],
    ["a PNG cut short", png(200, 100).subarray(0, 20)],
    ["a JPEG without a frame header", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ["an empty file", Buffer.alloc(0)],
  ])("refuses %s", (_name, bytes) => {
    expect(() => checkPlanImage(bytes)).toThrow(/image/i);
  });

  it("refuses a picture larger than the limit", () => {
    const big = Buffer.concat([png(200, 100), Buffer.alloc(MAX_PLAN_IMAGE_BYTES)]);
    expect(() => checkPlanImage(big)).toThrow(/8 MB/);
  });
});

describe("the plan image", () => {
  async function setup() {
    const ctx = await testApp();
    await seedStaff(ctx.database, "kontrol", { dashboard: "VIEW" });
    const headers = await bearer(ctx.app, "kontrol");
    const get = (url: string, extra: Record<string, string> = {}) => ctx.app.inject({ method: "GET", url, headers: { ...headers, ...extra } });
    return { ...ctx, filesDir: ctx.config.files.dir, headers, get };
  }

  it("is stored below the storage root with its size, announced in the state and served with nosniff and a private cache", async () => {
    const { database, filesDir, get } = await setup();
    const picture = png(400, 200);
    const result = await importPlan(database, filesDir, input({ image: "layout.png" }), SVG, picture);
    expect(result.image).toEqual({ format: "png", width: 400, height: 200, bytes: picture.length, status: "written" });
    expect((await readdir(join(filesDir, "control-room"))).sort()).toEqual(["plan-SMK-image.json", "plan-SMK-image.png", "plan-SMK.svg"]);

    const state = (await get("/api/control-room/state")).json();
    expect(state.planImage).toMatchObject({ width: 400, height: 200 });
    expect(state.planImage.version).toMatch(/^[0-9a-f]{16}$/);

    const response = await get("/api/control-room/plan-image");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toMatch(/^private/);
    expect(response.rawPayload.equals(picture)).toBe(true);
    const again = await get("/api/control-room/plan-image", { "if-none-match": String(response.headers.etag) });
    expect(again.statusCode).toBe(304);
  });

  it("answers 404 and no image in the state when none was imported", async () => {
    const { database, filesDir, get } = await setup();
    await importPlan(database, filesDir, input(), SVG);
    expect((await get("/api/control-room/state")).json().planImage).toBeNull();
    const response = await get("/api/control-room/plan-image");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("is refused without the dashboard module, to partner accounts and without a session", async () => {
    const { app, database, filesDir } = await setup();
    await importPlan(database, filesDir, input({ image: "layout.png" }), SVG, png(400, 200));
    await seedStaff(database, "lain", { gate: "EDIT" });
    await seedPartnerUser(database, "mitra", await seedPartner(database, "PT Mitra Contoh", { supplier: true }), { registrations: "EDIT" });
    const url = "/api/control-room/plan-image";
    expect((await app.inject({ method: "GET", url, headers: await bearer(app, "lain") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: await bearer(app, "mitra") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });

  it("is left alone when imported again unchanged or not named, replaced by a JPEG, and removed with null", async () => {
    const { database, filesDir, get } = await setup();
    await importPlan(database, filesDir, input({ image: "layout.png" }), SVG, png(400, 200));
    expect((await importPlan(database, filesDir, input({ image: "layout.png" }), SVG, png(400, 200))).image?.status).toBe("unchanged");
    expect((await importPlan(database, filesDir, input(), SVG)).image).toBeNull();
    expect((await get("/api/control-room/state")).json().planImage).toMatchObject({ width: 400, height: 200 });

    const photo = jpeg(800, 400);
    expect((await importPlan(database, filesDir, input({ image: "layout.jpg" }), SVG, photo)).image).toMatchObject({ format: "jpeg", status: "written" });
    expect((await readdir(join(filesDir, "control-room"))).sort()).toEqual(["plan-SMK-image.jpg", "plan-SMK-image.json", "plan-SMK.svg"]);
    expect((await get("/api/control-room/plan-image")).headers["content-type"]).toBe("image/jpeg");

    expect((await importPlan(database, filesDir, input({ image: null }), SVG)).image).toEqual({ status: "removed" });
    expect((await readdir(join(filesDir, "control-room"))).sort()).toEqual(["plan-SMK.svg"]);
    expect((await get("/api/control-room/plan-image")).statusCode).toBe(404);
  });

  it.each([
    ["a picture that is not PNG or JPEG", Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), /PNG or JPEG/],
    ["a picture of another shape than the plan", png(300, 300), /shape/],
  ])("refuses %s and writes nothing", async (_name, bytes, message) => {
    const { database, filesDir } = await setup();
    await expect(importPlan(database, filesDir, input({ image: "layout.png" }), SVG, bytes)).rejects.toThrow(message);
    expect((await shapes(database)).REG).toBeNull();
    await expect(stat(join(filesDir, "control-room"))).rejects.toThrow();
  });

  it("is refused when the plan file names an image but none is given", async () => {
    const { database, filesDir } = await setup();
    await expect(importPlan(database, filesDir, input({ image: "layout.png" }), SVG)).rejects.toThrow(/image/);
  });

  it("is read by npm run plan:import next to the plan file, and only its size is printed", async () => {
    const ctx = await testApp();
    const folder = await mkdtemp(join(tmpdir(), "tr-plan-"));
    onTestFinished(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, "plan.svg"), SVG);
    await writeFile(join(folder, "layout.png"), png(400, 200));
    await writeFile(join(folder, "plan.json"), JSON.stringify({ site: "SMK", viewBox: [200, 100], svg: "plan.svg", image: "layout.png", zones: ALL_ZONES }));
    const lines: string[] = [];
    const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, FILE_STORAGE_DIR: ctx.config.files.dir };
    const code = await runPlanImport(env, [join(folder, "plan.json")], (line) => lines.push(line), async () => ({ ...ctx.database, close: async () => {} }));
    expect(code, lines.join("\n")).toBe(0);
    expect(lines[0]).toMatch(/; image PNG 400 x 200 px, written\.$/);
    expect(lines.join("\n")).not.toContain(folder);
  });
});
