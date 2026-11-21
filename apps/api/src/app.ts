import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createGuards } from "./auth/guard.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerSsoRoutes } from "./auth/sso-routes.js";
import { SpeechCache, type SpeechEngine, speechEngineFor, warmSpeechCache } from "./speech/engine.js";
import type { Config } from "./config.js";
import { registerContractRoutes } from "./contracts/routes.js";
import type { Database } from "./db/client.js";
import { registerDeliveryOrderRoutes } from "./delivery-orders/routes.js";
import { registerDestinationRoutes } from "./destinations/routes.js";
import { registerDriverRoutes } from "./drivers/routes.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { registerExceptionRoutes } from "./exceptions/routes.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerLookupRoutes } from "./lookup/routes.js";
import { registerProductRoutes } from "./products/routes.js";
import { registerSyncRoutes } from "./odoo/routes.js";
import { registerTripRoutes } from "./trips/routes.js";
import { registerTripWorkRoutes } from "./trips/work-routes.js";
import { registerWeighbridgeRoutes } from "./weighing/routes.js";
import { registerPartnerRoutes } from "./partners/routes.js";
import { registerRegistrationRoutes } from "./registrations/routes.js";
import { registerReportRoutes } from "./reports/routes.js";
import { registerRfidCardRoutes } from "./rfid-cards/routes.js";
import { registerStationRoutes } from "./stations/routes.js";
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
  /** The voice; by default the engine TTS_ENGINE names. Tests pass their own. */
  speechEngine?: SpeechEngine;
  /** Makes the audio of the fixed sentences once the server listens (the server does; tests do not). */
  warmSpeech?: boolean;
}

/** Everything a route needs, built once per application. */
export interface AppContext {
  config: Config;
  database: Database;
  now: () => Date;
  /** One client for the whole process, so its login token is reused; null without VCF_URL. */
  vcf: VcfClient | null;
  registryPushTimeoutMs: number;
  speech: { engine: SpeechEngine; cache: SpeechCache };
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
    speech: { engine: options.speechEngine ?? speechEngineFor(options.config.tts), cache: new SpeechCache(options.config.tts.cacheDir) },
  };

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(helmet);
  await app.register(cors, { origin: [context.config.webOrigin], credentials: true });
  await app.register(cookie);
  app.decorateRequest("account", null);
  app.decorateRequest("station", null);
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
  registerProductRoutes(app, context, guards);
  registerLookupRoutes(app, context, guards);
  registerDestinationRoutes(app, context, guards);
  registerRfidCardRoutes(app, context, guards);
  registerDeliveryOrderRoutes(app, context, guards);
  registerRegistrationRoutes(app, context, guards);
  registerTripRoutes(app, context, guards);
  registerGateRoutes(app, context, guards);
  registerStationRoutes(app, context, guards);
  registerWeighbridgeRoutes(app, context);
  registerTripWorkRoutes(app, context, guards);
  registerExceptionRoutes(app, context, guards);
  registerReportRoutes(app, context, guards);

  if (options.warmSpeech) {
    // in the background: a slow voice never delays the start
    app.addHook("onListen", async () => {
      void warmSpeechCache(context.speech.engine, context.speech.cache)
        .then((made) => {
          if (made > 0) app.log.info({ made }, "speech cache warmed");
        })
        .catch((error: unknown) => app.log.warn({ err: error }, "speech cache warm-up failed"));
    });
  }

  return app;
}
