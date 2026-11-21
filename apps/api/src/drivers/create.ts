// Creating a driver here, used by POST /api/drivers and by a registration that enters a new driver in place.
// A driver entered here is not in the central registry yet: status UNKNOWN, queued to be sent there.
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../app.js";
import type { Orm } from "../db/client.js";
import { drivers } from "../db/schema.js";
import { pushPendingDrivers } from "../vcf/push.js";

export interface NewDriver {
  fullName: string;
  licenceNo: string;
  licenceClass: string;
  licenceValidUntil: string;
  phone?: string | undefined;
  homePartnerId?: number | null;
}

/** Inserts the driver queued for the registry (registry_push PENDING); answers its id. `orm` may be a transaction. */
export async function insertDriver(orm: Orm, input: NewDriver, actor: number, now: Date): Promise<number> {
  const [created] = await orm
    .insert(drivers)
    .values({ ...input, registryStatus: "UNKNOWN", registryPush: "PENDING", createdBy: actor, createdAt: now, updatedAt: now })
    .returning({ id: drivers.id });
  if (!created) throw new Error("The driver was not created.");
  return created.id;
}

/**
 * With a registry account the new driver is sent at once, within the push timeout. Whatever happens there the
 * driver stays here, and one that was not sent waits for the next sync run. Answers why the push stopped, if it did.
 */
export async function pushNewDriver(context: AppContext, driverId: number, log: FastifyBaseLogger): Promise<string | null> {
  if (!context.vcf?.canPush) return null;
  try {
    const signal = AbortSignal.timeout(context.registryPushTimeoutMs);
    const stopped = (await pushPendingDrivers(context.database, context.vcf, context.now, { driverId, signal })).stopped;
    if (stopped) log.warn({ reason: stopped }, "sending the new driver to the registry stopped");
    return stopped;
  } catch (error) {
    log.warn({ err: error }, "sending the new driver to the registry failed");
    return null;
  }
}

export const driverIdByLicence = async (orm: Orm, licenceNo: string): Promise<number | null> =>
  (await orm.select({ id: drivers.id }).from(drivers).where(eq(drivers.licenceNo, licenceNo)))[0]?.id ?? null;
