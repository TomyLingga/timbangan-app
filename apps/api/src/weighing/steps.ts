// The steps of a trip after check-in: which one is waiting, moving on after a step is done, the rejection
// rule, and repeating loading after a supervisor asks for more or less load. A repeated step is a new row
// with the next attempt number; only the latest attempt of each step counts.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { flowSteps, registrations, trips, tripSteps } from "../db/schema.js";

export type StepStatus = (typeof tripSteps.$inferSelect)["status"];
export type Outcome = NonNullable<(typeof trips.$inferSelect)["outcome"]>;

export interface StepInfo {
  id: number;
  stepCode: string;
  seq: number;
  attempt: number;
  status: StepStatus;
  result: "PASS" | "FAIL" | "HOLD" | null;
  name: string;
  isOptional: boolean;
  onReject: string;
  performerModule: string | null;
  stationId: number | null;
  performedBy: number | null;
  readyAt: Date | null;
  finishedAt: Date | null;
  note: string | null;
}

/** The latest attempt of every step of the trip, in flow order, with the flow's settings for each step. */
export async function loadSteps(orm: Orm, tripId: number): Promise<StepInfo[]> {
  const rows = await orm
    .select({ step: tripSteps, name: flowSteps.name, isOptional: flowSteps.isOptional, onReject: flowSteps.onReject, performerModule: flowSteps.performerModule })
    .from(tripSteps)
    .innerJoin(trips, eq(trips.id, tripSteps.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .leftJoin(flowSteps, and(eq(flowSteps.siteId, trips.siteId), eq(flowSteps.flowCode, registrations.flowCode), eq(flowSteps.stepCode, tripSteps.stepCode)))
    .where(eq(tripSteps.tripId, tripId))
    .orderBy(asc(tripSteps.seq), asc(tripSteps.attempt));
  const latest = new Map<string, StepInfo>();
  for (const { step, name, isOptional, onReject, performerModule } of rows) {
    latest.set(step.stepCode, {
      id: step.id,
      stepCode: step.stepCode,
      seq: step.seq,
      attempt: step.attempt,
      status: step.status,
      result: step.result,
      name: name ?? step.stepCode,
      isOptional: isOptional ?? false,
      onReject: onReject ?? "SKIP",
      performerModule: performerModule ?? null,
      stationId: step.stationId,
      performedBy: step.performedBy,
      readyAt: step.readyAt,
      finishedAt: step.finishedAt,
      note: step.note,
    });
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** The step waiting for its turn, if any. */
export const readyStep = (steps: StepInfo[]) => steps.find((step) => step.status === "READY" || step.status === "IN_PROGRESS") ?? null;

export interface Finish {
  status: "DONE" | "FAILED";
  result: "PASS" | "FAIL";
  performedBy?: number | null;
  stationId?: number | null;
  note?: string | null;
}

export async function finishStep(orm: Orm, stepId: number, finish: Finish, now: Date): Promise<void> {
  await orm
    .update(tripSteps)
    .set({
      status: finish.status,
      result: finish.result,
      performedBy: finish.performedBy ?? null,
      stationId: finish.stationId ?? null,
      note: finish.note ?? null,
      startedAt: now,
      finishedAt: now,
    })
    .where(eq(tripSteps.id, stepId));
}

/**
 * Makes the first waiting step READY and writes it to trips.current_step (null when nothing is left). An
 * optional step met on the normal path is skipped; after a rejection only the steps kept for it are left.
 */
export async function advance(orm: Orm, tripId: number, now: Date): Promise<StepInfo | null> {
  const steps = await loadSteps(orm, tripId);
  let next: StepInfo | null = readyStep(steps);
  if (!next) {
    for (const step of steps) {
      if (step.status !== "PENDING") continue;
      if (step.isOptional) {
        await orm.update(tripSteps).set({ status: "SKIPPED" }).where(eq(tripSteps.id, step.id));
        continue;
      }
      await orm.update(tripSteps).set({ status: "READY", readyAt: now }).where(eq(tripSteps.id, step.id));
      next = { ...step, status: "READY", readyAt: now };
      break;
    }
  }
  await orm.update(trips).set({ currentStep: next?.stepCode ?? null, updatedAt: now }).where(eq(trips.id, tripId));
  return next;
}

/** The outcome a failed step gives the trip. */
export function outcomeOf(stepCode: string): Outcome {
  if (stepCode === "SEAL_CHECK" || stepCode === "RESEAL" || stepCode === "SEALING") return "SEAL_REJECT";
  if (stepCode === "QC" || stepCode === "QC_LOADING") return "SPEC_REJECT";
  if (stepCode === "CLEANLINESS" || stepCode === "TANK_CHECK") return "TRUCK_REJECT";
  return "OTHER_REJECT";
}

/**
 * The rejection rule: the trip gets the outcome; every step not done yet is skipped unless the flow marks it
 * to run on rejection. A second weighing without a first one is skipped as well. Then the next kept step is READY.
 */
/** `alsoSkip`: steps the reject skips although the flow runs them for rejected trucks. */
export async function rejectTrip(orm: Orm, tripId: number, outcome: Outcome, now: Date, alsoSkip: string[] = []): Promise<StepInfo | null> {
  await orm.update(trips).set({ outcome, updatedAt: now }).where(eq(trips.id, tripId));
  const steps = await loadSteps(orm, tripId);
  const firstWeighed = steps.some((step) => step.stepCode === "WEIGH_1" && step.status === "DONE");
  const skipped = steps
    .filter((step) => step.status === "PENDING" || step.status === "READY")
    .filter((step) => step.onReject !== "RUN" || (step.stepCode === "WEIGH_2" && !firstWeighed) || alsoSkip.includes(step.stepCode))
    .map((step) => step.id);
  if (skipped.length) await orm.update(tripSteps).set({ status: "SKIPPED", readyAt: null }).where(inArray(tripSteps.id, skipped));
  // the kept steps now run, optional ones included
  const kept = steps.filter((step) => step.status === "PENDING" && !skipped.includes(step.id));
  const first = kept[0];
  if (first) {
    await orm.update(tripSteps).set({ status: "READY", readyAt: now }).where(eq(tripSteps.id, first.id));
  }
  await orm.update(trips).set({ currentStep: first?.stepCode ?? null, updatedAt: now }).where(eq(trips.id, tripId));
  return first ? { ...first, status: "READY", readyAt: now } : null;
}

/** Steps repeated when the supervisor asks for more or less load before the second weighing. */
export const RELOAD_STEPS = ["LOADING", "SEALING", "WEIGH_2"];

/**
 * The second weighing is refused (status FAILED) and loading, sealing and the second weighing start again as
 * new attempts; loading is READY.
 */
export async function repeatLoading(orm: Orm, tripId: number, now: Date): Promise<StepInfo | null> {
  const steps = await loadSteps(orm, tripId);
  const weigh = steps.find((step) => step.stepCode === "WEIGH_2");
  if (weigh && (weigh.status === "READY" || weigh.status === "IN_PROGRESS")) {
    await orm.update(tripSteps).set({ status: "FAILED", result: "FAIL", finishedAt: now }).where(eq(tripSteps.id, weigh.id));
  }
  const repeated = steps.filter((step) => RELOAD_STEPS.includes(step.stepCode));
  if (repeated.length === 0) return null;
  const first = repeated[0];
  await orm.insert(tripSteps).values(
    repeated.map((step) => ({
      tripId,
      stepCode: step.stepCode,
      seq: step.seq,
      attempt: step.attempt + 1,
      status: step === first ? ("READY" as const) : ("PENDING" as const),
      readyAt: step === first ? now : null,
    })),
  );
  await orm.update(trips).set({ currentStep: first?.stepCode ?? null, updatedAt: now }).where(eq(trips.id, tripId));
  return (await loadSteps(orm, tripId)).find((step) => step.stepCode === first?.stepCode) ?? null;
}
