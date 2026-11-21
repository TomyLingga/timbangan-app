import type { FastifyInstance } from "fastify";
import { inject, onTestFinished } from "vitest";
import { type AppOptions, buildApp } from "../../src/app.js";
import { type Config, loadConfig } from "../../src/config.js";
import { createDb, type Database } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { serverDatabase } from "../pg/server.js";

export const TEST_JWT_SECRET = "test-secret-test-secret-test-secret-0123";

/** A clock the test moves by hand. */
export class TestClock {
  constructor(private current = new Date("2026-11-20T03:00:00Z")) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * A database without tables: in-process PGlite, or under `npm run test:pg` a new database on the PostgreSQL server
 * that is dropped when it is closed. The caller closes it.
 */
export async function emptyDatabase(): Promise<Database> {
  const server = inject("pgServer");
  return server ? serverDatabase(server, false) : createDb("pglite://memory");
}

/** A fresh database with every migration applied; closed (and on a server dropped) when the test ends. */
export async function freshDatabase(): Promise<Database> {
  const server = inject("pgServer");
  const database = server ? await serverDatabase(server, true) : await createDb("pglite://memory");
  onTestFinished(() => database.close());
  await migrate(database);
  return database;
}

export interface TestApp {
  app: FastifyInstance;
  database: Database;
  config: Config;
  clock: TestClock;
}

/** The application on a fresh database. `env` adds or replaces environment keys; nothing is read from .env. */
export async function testApp(env: Record<string, string> = {}, options: Partial<AppOptions> = {}): Promise<TestApp> {
  const database = await freshDatabase();
  const config = loadConfig({ DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET, ...env });
  const clock = new TestClock();
  // TEST_LOG_ERRORS=1 prints the cause of each 500, which the answer itself never carries
  const logger = process.env.TEST_LOG_ERRORS === "1" ? { level: "error" } : false;
  const app = await buildApp({ config, database, now: clock.now, logger, ...options });
  onTestFinished(() => app.close());
  return { app, database, config, clock };
}
