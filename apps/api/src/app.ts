import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createGuards } from "./auth/guard.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerSsoRoutes } from "./auth/sso-routes.js";
import type { Config } from "./config.js";
import { registerContractRoutes } from "./contracts/routes.js";
import type { Database } from "./db/client.js";
import { registerDeliveryOrderRoutes } from "./delivery-orders/routes.js";
import { registerDestinationRoutes } from "./destinations/routes.js";
import { registerDriverRoutes } from "./drivers/routes.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerSyncRoutes } from "./odoo/routes.js";
import { registerTripRoutes } from "./trips/routes.js";
import { registerPartnerRoutes } from "./partners/routes.js";
import { registerRegistrationRoutes } from "./registrations/routes.js";
import { registerRfidCardRoutes } from "./rfid-cards/routes.js";
import { registerUserAdminRoutes } from "./users/routes.js";
import { type VcfClient, vcfClientFor } from "./vcf/client.js";
import { registerVcfRoutes } from "./vcf/routes.js";
import { registerVehicleRoutes } from "./vehicles/routes.js";

export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Keys that never reach a log line, at the top level and up to two levels down (`req.headers.cookie`). */
const SECRET_KEYS = ["authorization", "cookie", "password", "token"];
const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

/** How long POST /api/drivers waits for the registry before it answers anyway. */
export const DEFAULT_REGISTRY_PUSH_TIMEOUT_MS = 5_000;

export interface AppOptions {
  config: Config;
  database: Database;
  /** The clock; tests pass their own. */
  now?: () => Date;
  /** `false` silences the log; an object is merged into the pino options (level, stream). */
  logger?: false | Exclude<FastifyServerOptions["logger"], boolean | undefined>;
  /** Tests shorten it. */
  registryPushTimeoutMs?: number;
}

/** Everything a route needs, built once per application. */
export interface AppContext {
  config: Config;
  database: Database;
  now: () => Date;
  /** One client for the whole process, so its login token is reused; null without VCF_URL. */
  vcf: VcfClient | null;
  registryPushTimeoutMs: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { ...options.logger, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
  });
  const context: AppContext = {
    config: options.config,
    database: options.database,
    now: options.now ?? (() => new Date()),
    vcf: vcfClientFor(options.config.vcf),
    registryPushTimeoutMs: options.registryPushTimeoutMs ?? DEFAULT_REGISTRY_PUSH_TIMEOUT_MS,
  };

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(helmet);
  await app.register(cors, { origin: [context.config.webOrigin], credentials: true });
  await app.register(cookie);
  app.decorateRequest("account", null);
  const guards = createGuards(context);

  app.get("/api/health", async () => {
    let database: "up" | "down" = "up";
    try {
      await context.database.query("select 1");
    } catch {
      database = "down";
    }
    return { status: "ok", database, version: VERSION };
  });

  registerAuthRoutes(app, context, guards);
  registerSsoRoutes(app, context);
  registerSyncRoutes(app, context, guards);
  registerContractRoutes(app, context, guards);
  registerUserAdminRoutes(app, context, guards);
  registerVcfRoutes(app, context, guards);
  registerDriverRoutes(app, context, guards);
  registerVehicleRoutes(app, context, guards);
  registerPartnerRoutes(app, context, guards);
  registerDestinationRoutes(app, context, guards);
  registerRfidCardRoutes(app, context, guards);
  registerDeliveryOrderRoutes(app, context, guards);
  registerRegistrationRoutes(app, context, guards);
  registerTripRoutes(app, context, guards);
  registerGateRoutes(app, context, guards);

  return app;
}
