import type { FastifyRequest } from "fastify";
import { accountOf } from "./auth/guard.js";
import type { Orm } from "./db/client.js";
import { auditLog } from "./db/schema.js";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: number;
  before: unknown;
  after: unknown;
  reason?: string;
}

/** Appends one audit_log row for a change made by the signed-in user. `orm` may be a transaction. */
export async function writeAudit(orm: Orm, request: FastifyRequest, at: Date, entry: AuditEntry): Promise<void> {
  await orm.insert(auditLog).values({ ...entry, at, userId: accountOf(request).id, ip: request.ip });
}
