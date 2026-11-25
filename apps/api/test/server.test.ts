import { describe, expect, it, onTestFinished } from "vitest";
import { runMigrate } from "../src/cli/migrate.js";
import { ConfigError } from "../src/config.js";
import { startServer } from "../src/server.js";
import { emptyDatabase, TEST_JWT_SECRET } from "./helpers/app.js";

const env = { DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET };

describe("startServer", () => {
  it("listens, and migrates an in-memory database itself", async () => {
    // PORT 0 lets the operating system pick a free port
    const { app, address } = await startServer({ ...env, PORT: "0" }, { logger: false });
    onTestFinished(() => app.close());
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(`${address}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", database: "up" });

    // the tables exist: an unknown user is a 401, not a server error
    const login = await fetch(`${address}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "nothing" }),
    });
    expect(login.status).toBe(401);
  });

  it("stops with a readable message when the configuration is wrong", async () => {
    await expect(startServer({ DATABASE_URL: "pglite://memory" }, { logger: false })).rejects.toThrow(ConfigError);
    await expect(startServer({ DATABASE_URL: "pglite://memory" }, { logger: false })).rejects.toThrow(/JWT_SECRET/);
  });
});

describe("migrate command", () => {
  it("applies the migrations, and says so when there is nothing to apply", async () => {
    const database = await emptyDatabase();
    onTestFinished(() => database.close());
    const open = async () => ({ ...database, close: async () => {} });
    const lines: string[] = [];

    expect(await runMigrate(env, (line) => lines.push(line), open)).toBe(0);
    expect(lines).toEqual([
      "Applied 15 migrations: 0001_schema.sql, 0002_seed.sql, 0003_registration.sql, 0004_module_permissions.sql, 0005_weighing.sql, 0006_field_steps.sql, 0007_control_room.sql, 0008_tanks_attachments.sql, 0009_reports_modules.sql, 0010_legacy_archive.sql, 0011_gps.sql, 0012_gps_partner_access.sql, 0013_do_destination_pin.sql, 0014_notifications.sql, 0015_gate_post.sql",
    ]);

    lines.length = 0;
    expect(await runMigrate(env, (line) => lines.push(line), open)).toBe(0);
    expect(lines).toEqual(["Nothing to apply: 15 migrations were applied before."]);
  });

  it("prints the reason and exits with 1 when it cannot run", async () => {
    const lines: string[] = [];
    expect(await runMigrate({ JWT_SECRET: TEST_JWT_SECRET }, (line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).toContain("DATABASE_URL");
  });
});
