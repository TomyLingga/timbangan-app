// Deciding a QC hold (exception type QC_HOLD), raised by the receiving QC form when the operator chose HOLD or
// NOT OK. Approved: QC is done and unloading is ready. Rejected: the truck is rejected for its spec and goes
// through reseal, the second weighing and the exit.
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Account } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { exceptions, qualityChecks, trips, tripSteps } from "../db/schema.js";
import { invalidState } from "../errors.js";
import { advance, rejectTrip } from "../weighing/steps.js";
import { closeStep } from "./engine.js";

type ExceptionRow = typeof exceptions.$inferSelect;

export async function decideQcHold(tx: Orm, request: FastifyRequest, account: Account, row: ExceptionRow, decision: "APPROVE" | "REJECT", reason: string | null, now: Date) {
  const [trip] = await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, row.tripId)).for("update");
  const [step] = row.tripStepId === null ? [] : await tx.select().from(tripSteps).where(eq(tripSteps.id, row.tripStepId));
  if (!trip || !step || step.status !== "IN_PROGRESS" || step.result !== "HOLD") throw invalidState("Langkah QC truk ini sudah berubah.");
  const approve = decision === "APPROVE";
  const status = approve ? ("APPROVED" as const) : ("REJECTED" as const);
  await tx.update(exceptions).set({ status, decidedBy: account.id, decidedAt: now, decisionReason: reason }).where(eq(exceptions.id, row.id));
  if (row.qualityCheckId !== null) {
    await tx
      .update(qualityChecks)
      .set({ decision: approve ? "PASS" : "REJECT", decidedBy: account.id, decidedAt: now })
      .where(eq(qualityChecks.id, row.qualityCheckId));
  }
  // the operator who took the sample stays the performer of the step; the decider is on the request
  if (approve) {
    await closeStep(tx, step, { status: "DONE", result: "PASS", performedBy: step.performedBy, note: step.note }, now);
    await advance(tx, row.tripId, now);
  } else {
    await closeStep(tx, step, { status: "FAILED", result: "FAIL", performedBy: step.performedBy, note: step.note }, now);
    await rejectTrip(tx, row.tripId, "SPEC_REJECT", now);
  }
  await writeAudit(tx, request, now, {
    action: "EXCEPTION_DECIDED",
    entityType: "exception",
    entityId: row.id,
    before: { status: row.status },
    after: { status, decision, qualityCheckId: row.qualityCheckId },
    ...(reason ? { reason } : {}),
  });
  return { exceptionId: row.id, weighing: null, next: null };
}
