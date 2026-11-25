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
import { registerControlRoomRoutes } from "./control-room/routes.js";
import type { Database } from "./db/client.js";
import { registerDeliveryOrderRoutes } from "./delivery-orders/routes.js";
import { registerDestinationRoutes } from "./destinations/routes.js";
import { registerDriverRoutes } from "./drivers/routes.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { registerExceptionRoutes } from "./exceptions/routes.js";
import { registerAttachmentRoutes } from "./attachments/routes.js";
import { registerFileRoutes } from "./files/routes.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerWalkInRoutes } from "./gate/walk-in-routes.js";
import { registerGpsIntakeRoutes } from "./gps/intake-routes.js";
import { registerGpsMasterRoutes } from "./gps/master-routes.js";
import { registerGpsReadRoutes } from "./gps/read-routes.js";
import { scheduleGpsRetention } from "./gps/retention.js";
import { registerGpsShareRoutes } from "./gps/share-routes.js";
import { registerHistoryRoutes } from "./history/routes.js";
import { registerLookupRoutes } from "./lookup/routes.js";
import { fcmSenderFromFile } from "./notifications/fcm.js";
import type { PushSender } from "./notifications/push.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import { scheduleNotifications } from "./notifications/sender.js";
import { registerProductRoutes } from "./products/routes.js";
import { registerSyncRoutes } from "./odoo/routes.js";
import { registerTripRoutes } from "./trips/routes.js";
import { registerTripWorkRoutes } from "./trips/work-routes.js";
import { registerWeighbridgeRoutes } from "./weighing/routes.js";
import { registerPartnerRoutes } from "./partners/routes.js";
import { registerPlantMasterRoutes } from "./plant-masters/routes.js";
import { registerRegistrationRoutes } from "./registrations/routes.js";
import { registerReportRoutes } from "./reports/routes.js";
import { registerRfidCardRoutes } from "./rfid-cards/routes.js";
import { registerShipmentRequestRoutes } from "./shipment-requests/routes.js";
import { registerStationRoutes } from "./stations/routes.js";
import { runDailySync, scheduleDailySync } from "./sync/daily.js";
import { SyncLock } from "./sync/lock.js";
import { registerUserAdminRoutes } from "./users/routes.js";
import { type VcfClient, vcfClientFor } from "./vcf/client.js";
import { registerVcfRoutes } from "./vcf/routes.js";
import { registerVehicleRoutes } from "./vehicles/routes.js";
import { registerFormRoutes } from "./work/form-routes.js";
import { registerWorkRoutes } from "./work/routes.js";

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
  /** Deletes GPS points past their retention once a day while the server listens (the server does; tests do not). */
  gpsRetention?: boolean;
  /** Pulls Odoo and VCF each day at SYNC_DAILY_AT while the server listens (the server does; tests do not). */
  dailySync?: boolean;
  /** Runs the notification loop while the server listens (the server does; tests do not). */
  notifications?: boolean;
  /** The push provider; by default the one PUSH_PROVIDER names (none when off). Tests pass their own or null. */
  pushSender?: PushSender | null;
  /** Tests pass one to share it with a daily pull they run by hand. */
  syncLock?: SyncLock;
}

/** Everything a route needs, built once per application. */
export interface AppContext {
  config: Config;
  database: Database;
  now: () => Date;
  /** One client for the whole process, so its login token is reused; null without VCF_URL. */
  vcf: VcfClient | null;
  registryPushTimeoutMs: number;
  /** One Odoo and one VCF pull at a time in this process: the web buttons and the daily pull. */
  syncLock: SyncLock;
  /** Null when PUSH_PROVIDER=off or the key file could not be read: pushes then stay pending. */
  push: PushSender | null;
  speech: { engine: SpeechEngine; cache: SpeechCache };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // TRUST_PROXY: trust only the immediate peer (the one proxy in front of the API) and take the client from the last
    // address it appended to X-Forwarded-For. A hop count is not used: Fastify 5 treats it as trusting nobody.
    trustProxy: options.config.trustProxy ? (_address: string, hop: number) => hop === 0 : false,
    logger: options.logger === false ? false : { ...options.logger, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    // an FCM token in DELETE /api/devices/:pushToken is longer than the default 100 characters
    maxParamLength: 4096,
  });
  let push: PushSender | null = options.pushSender ?? null;
  if (options.pushSender === undefined && options.config.push.provider === "fcm") {
    try {
      push = await fcmSenderFromFile(options.config.push.serviceAccountFile);
    } catch (error) {
      // the API still starts: notifications stay in the inbox and pushes wait until the file is fixed
      app.log.error({ reason: error instanceof Error ? error.message : String(error) }, "push disabled: the FCM service account file is not usable");
    }
  }
  const context: AppContext = {
    config: options.config,
    database: options.database,
    now: options.now ?? (() => new Date()),
    vcf: vcfClientFor(options.config.vcf),
    registryPushTimeoutMs: options.registryPushTimeoutMs ?? DEFAULT_REGISTRY_PUSH_TIMEOUT_MS,
    syncLock: options.syncLock ?? new SyncLock(),
    push,
    speech: { engine: options.speechEngine ?? speechEngineFor(options.config.tts), cache: new SpeechCache(options.config.tts.cacheDir) },
  };

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(helmet);
  // content-disposition: the web page reads the file name of a CSV download
  // without `methods` the plugin allows only GET, HEAD and POST across origins
  await app.register(cors, {
    origin: [context.config.webOrigin],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["content-disposition"],
  });
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
  registerShipmentRequestRoutes(app, context, guards);
  registerRegistrationRoutes(app, context, guards);
  registerTripRoutes(app, context, guards);
  registerGateRoutes(app, context, guards);
  registerStationRoutes(app, context, guards);
  registerWeighbridgeRoutes(app, context);
  registerTripWorkRoutes(app, context, guards);
  registerExceptionRoutes(app, context, guards);
  registerReportRoutes(app, context, guards);
  registerHistoryRoutes(app, context, guards);
  registerPlantMasterRoutes(app, context, guards);
  await registerFileRoutes(app, context, guards);
  registerAttachmentRoutes(app, context, guards);
  // after the file routes: the scan upload uses the multipart parser they register
  registerWalkInRoutes(app, context, guards);
  registerWorkRoutes(app, context, guards);
  registerFormRoutes(app, context, guards);
  registerControlRoomRoutes(app, context, guards);
  registerGpsIntakeRoutes(app, context);
  registerGpsMasterRoutes(app, context, guards);
  registerGpsShareRoutes(app, context, guards);
  registerGpsReadRoutes(app, context, guards);
  registerNotificationRoutes(app, context, guards);

  if (options.gpsRetention) {
    let stop: (() => void) | null = null;
    app.addHook("onListen", async () => {
      stop = scheduleGpsRetention(context.database, context.now, {
        info: (data, message) => app.log.info(data, message),
        warn: (data, message) => app.log.warn(data, message),
      });
    });
    app.addHook("onClose", async () => stop?.());
  }

  if (options.dailySync) {
    let stop: (() => void) | null = null;
    app.addHook("onListen", async () => {
      const log = {
        info: (data: object, message: string) => app.log.info(data, message),
        warn: (data: object, message: string) => app.log.warn(data, message),
        error: (data: object, message: string) => app.log.error(data, message),
      };
      stop = scheduleDailySync(context.config.syncDailyAt, context.now, () => runDailySync(context, log), log);
      if (stop) app.log.info({ at: context.config.syncDailyAt, odoo: context.config.odoo !== null, vcf: context.vcf !== null }, "daily Odoo and VCF pull scheduled");
    });
    app.addHook("onClose", async () => stop?.());
  }

  if (options.notifications) {
    let stop: (() => Promise<void>) | null = null;
    app.addHook("onListen", async () => {
      stop = scheduleNotifications(context.database.db, context.now, context.push, {
        info: (data, message) => app.log.info(data, message),
        warn: (data, message) => app.log.warn(data, message),
      });
      app.log.info({ push: context.push?.provider ?? "off" }, "notification loop started");
    });
    app.addHook("onClose", async () => stop?.());
  }

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
