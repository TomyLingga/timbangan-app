import type { FastifyInstance } from "fastify";
import { onTestFinished } from "vitest";
import { type AppOptions, buildApp } from "../../src/app.js";
import { type Config, loadConfig } from "../../src/config.js";
import { createDb, type Database } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

export const TEST_JWT_SECRET = "test-secret-test-secret-test-secret-0123";

/** A clock the test moves by hand. */
export class TestClock {
  constructor(private current = new Date("2026-11-20T03:00:00Z")) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** A fresh in-memory database with every migration applied; closed when the test ends. */
export async function freshDatabase(): Promise<Database> {
  const database = await createDb("pglite://memory");
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
  const app = await buildApp({ config, database, now: clock.now, logger: false, ...options });
  onTestFinished(() => app.close());
  return { app, database, config, clock };
}
