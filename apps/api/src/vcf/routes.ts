import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { AppError, notConfigured } from "../errors.js";
import { syncVcf } from "./sync.js";

export function registerVcfRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const admin = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("drivers", "EDIT")] };
  // One run at a time in this process, shared with the daily pull (src/sync/daily.ts). `npm run sync:vcf` in
  // another process is not seen here.
  app.post("/api/admin/sync/vcf", admin, async (request) => {
    const client = context.vcf;
    if (!client) throw notConfigured("Master supir pusat");
    const release = context.syncLock.acquire("vcf");
    if (!release) throw new AppError(409, "SYNC_RUNNING", "Sinkronisasi master supir sedang berjalan.");
    try {
      const result = await syncVcf(context.database, client, context.now);
      if (result.pushStopped) request.log.warn({ reason: result.pushStopped }, "sending drivers to the registry stopped");
      return result;
    } catch (error) {
      request.log.error({ err: error }, "driver registry sync failed");
      throw new AppError(502, "SYNC_FAILED", "Sinkronisasi master supir gagal. Lihat riwayat sinkronisasi.");
    } finally {
      release();
    }
  });
}
