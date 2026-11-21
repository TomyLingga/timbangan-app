import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { erpSyncRuns } from "../db/schema.js";
import { AppError, notConfigured } from "../errors.js";
import { OdooClient } from "./client.js";
import { syncOdoo } from "./sync.js";

const LIMIT_MESSAGE = "Limit harus antara 1 dan 100.";
const runsQuery = z.object({
  limit: z.coerce.number(LIMIT_MESSAGE).int(LIMIT_MESSAGE).min(1, LIMIT_MESSAGE).max(100, LIMIT_MESSAGE).default(20),
});

export function registerSyncRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const syncing = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("contracts", "EDIT")] };
  // the history holds both the Odoo and the driver registry runs
  const history = { preHandler: [guards.authenticate, guards.requireInternal, guards.requireAnyPermission(["contracts", "VIEW"], ["drivers", "VIEW"])] };
  // One run at a time in this process. `npm run sync:odoo` in another process is not seen here.
  let running = false;

  app.post("/api/admin/sync/odoo", syncing, async (request) => {
    if (!context.config.odoo) throw notConfigured("Odoo");
    if (running) throw new AppError(409, "SYNC_RUNNING", "Sinkronisasi Odoo sedang berjalan.");
    running = true;
    try {
      return await syncOdoo(context.database, new OdooClient(context.config.odoo), context.now);
    } catch (error) {
      request.log.error({ err: error }, "odoo sync failed");
      throw new AppError(502, "SYNC_FAILED", "Sinkronisasi Odoo gagal. Lihat riwayat sinkronisasi.");
    } finally {
      running = false;
    }
  });

  app.get("/api/admin/sync/runs", history, async (request) => {
    const { limit } = runsQuery.parse(request.query);
    return { items: await context.database.db.select().from(erpSyncRuns).orderBy(desc(erpSyncRuns.id)).limit(limit) };
  });
}
