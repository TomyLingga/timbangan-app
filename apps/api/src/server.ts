// Entry point: `npm run dev` and `npm start`. Both load .env through Node's --env-file-if-exists.
import type { FastifyInstance } from "fastify";
import { type AppOptions, buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";

export async function startServer(
  env: Record<string, string | undefined>,
  options: { logger?: AppOptions["logger"] } = {},
): Promise<{ app: FastifyInstance; address: string }> {
  const config = loadConfig(env);
  const database = await createDb(config.databaseUrl);
  try {
    // An in-memory database is empty at every start, so nothing else can have migrated it.
    // Every other database is migrated with `npm run migrate`.
    if (config.databaseUrl === "pglite://memory") await migrate(database);
    const app = await buildApp({ config, database, logger: options.logger ?? { level: "info" } });
    app.addHook("onClose", () => database.close());
    const address = await app.listen({ port: config.port, host: config.host });
    return { app, address };
  } catch (error) {
    await database.close();
    throw error;
  }
}

if (import.meta.main) {
  try {
    const { app } = await startServer(process.env);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  }
}
