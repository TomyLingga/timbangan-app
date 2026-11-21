// The plant plan: `npm run plan:import` writes the zone polygons and keeps the drawing below the storage root; the
// drawing is checked first, because the web page puts it into its own document.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEMO_PLAN_SVG, DEMO_ZONE_SHAPES } from "../src/control-room/demo-plan.js";
import { checkPlanSvg, importPlan, planFilePath } from "../src/control-room/plan.js";
import { runPlanImport } from "../src/control-room/plan-import.js";
import { testApp, TEST_JWT_SECRET } from "./helpers/app.js";
import { bearer, seedStaff } from "./helpers/users.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g fill="none" stroke="currentColor"><rect x="1" y="1" width="198" height="98"/><path d="M10 50 H190"/></g></svg>';
const square = (x: number, y: number) => [[x, y], [x + 0.05, y], [x + 0.05, y + 0.05], [x, y + 0.05]];
const ALL_ZONES = Object.fromEntries(["REG", "QUEUE", "WB", "QC", "STAGING", "DOCK", "LOADING", "UNLOADING", "SEAL"].map((code, index) => [code, square(index * 0.1, 0.5)]));
// unknown on purpose: the import checks the shape itself
const input = (overrides: Partial<Record<"site" | "viewBox" | "zones", unknown>> = {}): unknown => ({ site: "SMK", viewBox: [200, 100], zones: ALL_ZONES, ...overrides });

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
    expect(result).toEqual({ site: "SMK", zones: 9, changed: 9, unchanged: 0, svgBytes: Buffer.byteLength(SVG), svgChanged: true });
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
