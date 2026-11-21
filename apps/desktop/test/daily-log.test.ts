import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDailyLog } from "../src/main/daily-log";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("daily log", () => {
  it("writes one JSON line per entry into a file per local day", async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-log-"));
    let now = new Date(2026, 10, 21, 23, 59, 0).getTime();
    const log = createDailyLog(dir, () => now);
    log.write("stable", { weightKg: 41_500 });
    now = new Date(2026, 10, 22, 0, 0, 5).getTime();
    log.write("api", { method: "GET", path: "/api/weighbridge/card/04A1B2C3D4", status: 200, ms: 12 });
    await log.flush();
    expect((await readdir(dir)).sort()).toEqual(["2026-11-21.log", "2026-11-22.log"]);
    const first = JSON.parse((await readFile(join(dir, "2026-11-21.log"), "utf8")).trim());
    expect(first).toMatchObject({ event: "stable", weightKg: 41_500 });
    expect(typeof first.at).toBe("string");
  });

  it("never writes a station key, a PIN or a key header", async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-log-"));
    const log = createDailyLog(dir, () => Date.now());
    log.write("settings", { stationKey: "st3.secret-value", pin: "4321", headers: { "x-station-key": "st3.secret-value" }, note: "ok" });
    await log.flush();
    const [file] = await readdir(dir);
    const text = await readFile(join(dir, file ?? ""), "utf8");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("4321");
    expect(JSON.parse(text.trim())).toMatchObject({ stationKey: "[hidden]", pin: "[hidden]", headers: { "x-station-key": "[hidden]" }, note: "ok" });
  });
});
