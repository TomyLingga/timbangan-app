// One weigh request from the weighbridge program, from the trip at its step to the answer: the checks in
// order, a plate retry, a request for a decision, or the saved weighing.
import { and, count, desc, eq, gt } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { exceptions, weighbridgeRequests } from "../db/schema.js";
import { raiseException, pendingSpoken } from "../exceptions/service.js";
import { checksFor, type CheckType, runCheck } from "./checks.js";
import { messages } from "./messages.js";
import { saveWeighing, type WeighContext } from "./service.js";
import { loadWeighTrip, weighingView } from "./view.js";

export interface WeighInput {
  stationId: number;
  weightKg: number;
  plateRead: string | null;
  cardUid: string | null;
  ip: string | null;
}

export interface ProceedOptions {
  /** Checks up to and including this one were passed or approved already. */
  after: CheckType | null;
  /** The station's plate attempts; null when no retry is allowed (after a decision). */
  plateAttempts: number | null;
  plateCheck: "MATCH" | "CONFIRMED";
  mode: "AUTO" | "EXCEPTION";
  decidedBy?: number | null;
}

export type WeighAnswer =
  | { statusCode: 200; result: "SAVED"; body: Record<string, unknown>; weighingId: number }
  | { statusCode: 202; result: "PENDING"; body: Record<string, unknown>; exceptionId: number }
  | { statusCode: 200; result: "PLATE_RETRY"; body: Record<string, unknown> };

/** Saves the weighing and builds the SAVED answer. */
export async function saveAndAnswer(orm: Orm, context: WeighContext, input: WeighInput, options: ProceedOptions, now: Date) {
  const { weighing, netKg, next } = await saveWeighing(orm, context, { ...input, plateCheck: options.plateCheck, mode: options.mode, decidedBy: options.decidedBy ?? null }, now);
  const spoken = messages.saved({ stage: context.stage, kind: context.kind, weightKg: input.weightKg, netKg, next: next?.name ?? null });
  return {
    weighing,
    body: { result: "SAVED" as const, weighing: weighingView(weighing), trip: await loadWeighTrip(orm, context.trip.id), ...spoken },
  };
}

/** Plate retries answered at this weighing step since the last plate request of the step. */
async function plateRetriesSoFar(orm: Orm, context: WeighContext): Promise<number> {
  const [lastPlate] = await orm
    .select({ raisedAt: exceptions.raisedAt })
    .from(exceptions)
    .where(and(eq(exceptions.tripStepId, context.step.id), eq(exceptions.type, "PLATE")))
    .orderBy(desc(exceptions.raisedAt))
    .limit(1);
  const [row] = await orm
    .select({ n: count() })
    .from(weighbridgeRequests)
    .where(and(eq(weighbridgeRequests.tripStepId, context.step.id), eq(weighbridgeRequests.result, "PLATE_RETRY"), lastPlate ? gt(weighbridgeRequests.createdAt, lastPlate.raisedAt) : undefined));
  return Number(row?.n ?? 0);
}

/** Runs the checks after `options.after`; the first that fails asks for a decision, otherwise the weighing is saved. */
export async function proceed(orm: Orm, context: WeighContext, input: WeighInput, options: ProceedOptions, now: Date): Promise<WeighAnswer> {
  const checks = checksFor(context.direction, context.stage);
  const start = options.after === null ? 0 : checks.indexOf(options.after) + 1;
  for (const type of checks.slice(start)) {
    const finding = await runCheck(orm, context, type, input.weightKg, input.plateRead, now);
    if (!finding) continue;
    if (type === "PLATE" && options.plateAttempts !== null) {
      const attempt = (await plateRetriesSoFar(orm, context)) + 1;
      if (attempt < options.plateAttempts) {
        return { statusCode: 200, result: "PLATE_RETRY", body: { result: "PLATE_RETRY", attemptsLeft: options.plateAttempts - attempt, ...messages.plateRetry() } };
      }
    }
    const raised = await raiseException(orm, context, finding, { ...input, plateCheck: options.plateCheck }, now);
    return { statusCode: 202, result: "PENDING", exceptionId: raised.id, body: { result: "PENDING", exception: { id: raised.id, type: raised.type }, ...pendingSpoken(raised) } };
  }
  const { weighing, body } = await saveAndAnswer(orm, context, input, options, now);
  return { statusCode: 200, result: "SAVED", body, weighingId: weighing.id };
}
