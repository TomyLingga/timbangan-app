// Exceptions raised at the weighbridge: raising one, the live weight while the truck waits, lazy expiry when
// the weighbridge program stops sending, and how a request is shown.
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Account, can } from "../auth/guard.js";
import type { Orm } from "../db/client.js";
import { type ExceptionType, exceptions, stations, trips, users, vehicles } from "../db/schema.js";
import { type Finding, figures, type Measure } from "../weighing/checks.js";
import { messages } from "../weighing/messages.js";
import type { WeighContext } from "../weighing/service.js";
import type { Spoken } from "../weighing/speech.js";

/** Without a heartbeat for this long a waiting request is cancelled and the truck has not been weighed. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** The types raised by the weighbridge. */
export const WEIGHING_TYPES = ["PLATE", "GROSS_IN", "TARE_OUT", "NET_IN", "NET_OUT"] as const;
/** The types raised by the field forms: no heartbeat, no expiry, decided by the holders of qc_approvals. */
export const QC_TYPES = ["QC_HOLD"] as const;

/** The types an account may see: weighbridge requests with approvals, QC holds with qc_approvals. */
export function visibleTypes(account: Account): ExceptionType[] {
  return [...(can(account, "approvals", "VIEW") ? WEIGHING_TYPES : []), ...(can(account, "qc_approvals", "VIEW") ? QC_TYPES : [])];
}

export type ExceptionRow = typeof exceptions.$inferSelect;

/** What an exception keeps in `context` besides the plates and figures shown to the approver. */
export interface ExceptionContext {
  stage: 1 | 2;
  kind: "GROSS" | "TARE";
  cardUid: string | null;
  plateRead: string | null;
  plateNo: string;
  plateDisplay: string;
  /** MATCH, or CONFIRMED when a plate request was approved before this one. */
  plateCheck: "MATCH" | "CONFIRMED";
  measure: Measure | null;
  baseKg: number | null;
  cancelReason?: "TIMEOUT" | "TRUCK_LEFT" | "OPERATOR";
  /** After an approved plate: the request the next check raised. */
  nextExceptionId?: number;
  masterTareUpdated?: boolean;
  [key: string]: unknown;
}

export const contextOf = (row: ExceptionRow) => row.context as ExceptionContext;

/**
 * Lazy expiry: every waiting weighbridge request without a heartbeat for longer than the timeout becomes
 * CANCELLED. Called wherever requests are read or written, so no timer is needed.
 */
export async function expireStaleExceptions(orm: Orm, now: Date): Promise<void> {
  const limit = new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS);
  // The last sign of life is the live weight, or the raise when none came. Compared column by column: a Date bound
  // to a raw sql expression has no column type, and postgres.js cannot send it (PGlite can).
  const silentSince = or(lt(exceptions.liveWeightAt, limit), and(isNull(exceptions.liveWeightAt), lt(exceptions.raisedAt, limit)));
  await orm
    .update(exceptions)
    .set({ status: "CANCELLED", context: sql`${exceptions.context} || '{"cancelReason":"TIMEOUT"}'::jsonb` })
    .where(and(eq(exceptions.status, "PENDING"), inArray(exceptions.type, [...WEIGHING_TYPES]), silentSince));
}

export interface RaiseInput {
  stationId: number;
  weightKg: number;
  plateRead: string | null;
  cardUid: string | null;
  plateCheck: "MATCH" | "CONFIRMED";
}

export async function raiseException(orm: Orm, context: WeighContext, finding: Finding, input: RaiseInput, now: Date): Promise<ExceptionRow> {
  const { actual, diff, diffPct } = figures(finding.expected, finding.measure, finding.baseKg, input.weightKg);
  const stored: ExceptionContext = {
    stage: context.stage,
    kind: context.kind,
    cardUid: input.cardUid,
    plateRead: input.plateRead,
    plateNo: context.plateNo,
    plateDisplay: context.plateDisplay,
    plateCheck: input.plateCheck,
    measure: finding.measure,
    baseKg: finding.baseKg,
    ...finding.extra,
  };
  const [row] = await orm
    .insert(exceptions)
    .values({
      siteId: context.trip.siteId,
      tripId: context.trip.id,
      tripStepId: context.step.id,
      stationId: input.stationId,
      type: finding.type,
      status: "PENDING",
      expectedValue: finding.expected,
      actualValue: actual,
      diffValue: diff,
      diffPct,
      tolerancePct: finding.tolerancePct,
      liveWeightKg: input.weightKg,
      liveWeightAt: now,
      context: stored,
      approverModule: finding.approverModule,
      raisedAt: now,
    })
    .returning();
  if (!row) throw new Error("The exception was not saved.");
  return row;
}

/** Records the weight the weighbridge sent while the truck waits, and the figures that follow from it. */
export async function recordLiveWeight(orm: Orm, row: ExceptionRow, weightKg: number, now: Date): Promise<void> {
  const context = contextOf(row);
  const { actual, diff, diffPct } = figures(row.expectedValue, context.measure, context.baseKg, weightKg);
  await orm
    .update(exceptions)
    .set({ liveWeightKg: weightKg, liveWeightAt: now, ...(context.measure === null ? {} : { actualValue: actual, diffValue: diff, diffPct }) })
    .where(eq(exceptions.id, row.id));
}

/** The waiting request of this trip, if any (one per trip and type; the weighbridge works on one at a time). */
export async function openException(orm: Orm, tripId: number): Promise<ExceptionRow | null> {
  const [row] = await orm
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.tripId, tripId), eq(exceptions.status, "PENDING"), inArray(exceptions.type, [...WEIGHING_TYPES])))
    .orderBy(desc(exceptions.raisedAt), desc(exceptions.id))
    .limit(1);
  return row ?? null;
}

/** The sentences that tell the driver why the truck waits. */
export function pendingSpoken(row: ExceptionRow): Spoken {
  const context = contextOf(row);
  const actual = row.actualValue ?? row.liveWeightKg ?? 0;
  switch (row.type) {
    case "PLATE":
      return messages.pending.PLATE(context.plateRead, context.plateDisplay);
    case "GROSS_IN":
      return messages.pending.GROSS_IN(actual, row.expectedValue ?? 0);
    case "TARE_OUT":
      return messages.pending.TARE_OUT(row.liveWeightKg ?? actual, context.masterTareKg === null || context.vehicleVerified === false ? null : (row.expectedValue ?? null));
    case "NET_IN":
      return messages.pending.NET_IN(actual, row.expectedValue ?? 0);
    default:
      return messages.pending.NET_OUT(actual);
  }
}

/** The decision of a decided request as the weighbridge and the approver name it. */
export function decisionOf(row: ExceptionRow): string | null {
  if (row.status === "RETRY") return row.decisionCode;
  if (row.status === "APPROVED") return row.type === "NET_OUT" ? "OK" : "APPROVE";
  if (row.status === "REJECTED") return "REJECT";
  return null;
}

const decider = alias(users, "exception_decider");

/** Requests as the approver sees them: figures, plates, trip, station, who decided. */
export async function loadExceptionViews(orm: Orm, where: SQL | undefined, limit: number) {
  const rows = await orm
    .select({
      exception: exceptions,
      tripNo: trips.tripNo,
      tripPlate: trips.plateNo,
      plateDisplay: vehicles.plateDisplay,
      stationId: stations.id,
      stationCode: stations.code,
      stationName: stations.name,
      deciderName: decider.fullName,
    })
    .from(exceptions)
    .innerJoin(trips, eq(trips.id, exceptions.tripId))
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(stations, eq(stations.id, exceptions.stationId))
    .leftJoin(decider, eq(decider.id, exceptions.decidedBy))
    .where(where)
    .orderBy(desc(exceptions.raisedAt), desc(exceptions.id))
    .limit(limit);
  return rows.map(({ exception: row, ...joined }) => {
    const context = contextOf(row);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      decision: decisionOf(row),
      trip: { id: row.tripId, tripNo: joined.tripNo, plateNo: joined.tripPlate, plateDisplay: joined.plateDisplay },
      station: joined.stationId === null ? null : { id: joined.stationId, code: joined.stationCode, name: joined.stationName },
      stage: context.stage ?? null,
      expectedValue: row.expectedValue,
      actualValue: row.actualValue,
      diffValue: row.diffValue,
      diffPct: row.diffPct,
      tolerancePct: row.tolerancePct,
      liveWeightKg: row.liveWeightKg,
      liveWeightAt: row.liveWeightAt,
      plateRead: context.plateRead ?? null,
      plateNo: context.plateNo ?? joined.tripPlate,
      approverModule: row.approverModule,
      raisedAt: row.raisedAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy === null ? null : { id: row.decidedBy, fullName: joined.deciderName },
      reason: row.decisionReason,
      reportNo: row.reportNo,
      weighingId: row.weighingId,
      qualityCheckId: row.qualityCheckId,
      context: row.context,
    };
  });
}

export type ExceptionView = Awaited<ReturnType<typeof loadExceptionViews>>[number];
