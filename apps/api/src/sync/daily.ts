// The daily pull: at SYNC_DAILY_AT (plant time) the API reads Odoo in full mode, so delivered quantities are fresh,
// and then the driver registry (VCF), each only when it is configured. Both go through the same lock as the web
// buttons. A failure is logged (and recorded in erp_sync_runs by the pull itself); the next try is the next day.
import type { AppContext } from "../app.js";
import { todayAtPlant } from "../http.js";
import { PLANT_UTC_OFFSET } from "../legacy/values.js";
import { OdooClient } from "../odoo/client.js";
import { type SyncResult, syncOdoo } from "../odoo/sync.js";
import { type VcfSyncResult, syncVcf } from "../vcf/sync.js";
import type { SyncKind } from "./lock.js";

const DAY_MS = 86_400_000;

/**
 * The next moment after `now` when the plant clock shows `at` ("HH:MM"). Asia/Jakarta has no daylight saving time,
 * so the day after is always 24 hours later.
 */
export function nextDailyRun(now: Date, at: string): Date {
  const today = new Date(`${todayAtPlant(now)}T${at}:00${PLANT_UTC_OFFSET}`);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + DAY_MS);
}

export type PullOutcome<T> =
  | { status: "OK"; result: T }
  | { status: "SKIPPED"; reason: "NOT_CONFIGURED" | "RUNNING" }
  | { status: "FAILED"; error: string };

export interface DailySyncReport {
  odoo: PullOutcome<SyncResult>;
  vcf: PullOutcome<VcfSyncResult>;
}

export interface SyncLog {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
  error: (data: object, message: string) => void;
}

type DailyContext = Pick<AppContext, "config" | "database" | "now" | "vcf" | "syncLock">;

async function pull<T>(context: DailyContext, kind: SyncKind, configured: boolean, run: () => Promise<T>, log: SyncLog): Promise<PullOutcome<T>> {
  if (!configured) return { status: "SKIPPED", reason: "NOT_CONFIGURED" };
  const release = context.syncLock.acquire(kind);
  if (!release) {
    log.info({ pull: kind }, "daily pull skipped: a pull is running already");
    return { status: "SKIPPED", reason: "RUNNING" };
  }
  try {
    return { status: "OK", result: await run() };
  } catch (error) {
    log.error({ pull: kind, err: error }, "daily pull failed");
    return { status: "FAILED", error: error instanceof Error ? error.message : String(error) };
  } finally {
    release();
  }
}

/** Odoo in full mode, then VCF. A failure of the first never stops the second. */
export async function runDailySync(context: DailyContext, log: SyncLog): Promise<DailySyncReport> {
  const { odoo } = context.config;
  const odooOutcome = await pull(
    context,
    "odoo",
    odoo !== null,
    () => syncOdoo(context.database, new OdooClient(odoo as NonNullable<typeof odoo>), context.now, { tankParentLocationId: context.config.odooTankParentLocationId, full: true }),
    log,
  );
  if (odooOutcome.status === "OK") log.info({ pull: "odoo", ...odooOutcome.result }, "daily Odoo pull finished");
  const vcf = context.vcf;
  const vcfOutcome = await pull(context, "vcf", vcf !== null, () => syncVcf(context.database, vcf as NonNullable<typeof vcf>, context.now), log);
  if (vcfOutcome.status === "OK") {
    log.info({ pull: "vcf", ...vcfOutcome.result }, "daily VCF pull finished");
    if (vcfOutcome.result.pushStopped) log.warn({ reason: vcfOutcome.result.pushStopped }, "sending drivers to the registry stopped");
  }
  return { odoo: odooOutcome, vcf: vcfOutcome };
}

/**
 * Calls `run` every day at `at` (plant time) until the answered function is called. Null when `at` is null: then
 * nothing is scheduled. A run that throws is logged; the next one is still the next day.
 */
export function scheduleDailySync(at: string | null, now: () => Date, run: () => Promise<unknown>, log: Pick<SyncLog, "error">): (() => void) | null {
  if (at === null) return null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const arm = (after: Date) => {
    if (stopped) return;
    const target = nextDailyRun(after, at);
    timer = setTimeout(() => void fire(target), Math.max(0, target.getTime() - now().getTime()));
    timer.unref();
  };
  const fire = async (target: Date) => {
    try {
      await run();
    } catch (error) {
      log.error({ err: error }, "daily pull failed");
    }
    // from after the target, so a timer that fired a moment early never runs the same day twice
    arm(new Date(Math.max(now().getTime(), target.getTime() + 1000)));
  };
  arm(now());
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
