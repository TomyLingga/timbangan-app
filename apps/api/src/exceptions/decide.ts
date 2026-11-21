// Deciding a weighbridge request, and the answer the weighbridge program gets about it. The outcomes follow
// the decision table of the design (docs/fase-4-rancangan.md, section 2).
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type Account, can } from "../auth/guard.js";
import type { ModuleCode } from "../auth/permissions.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { exceptions, sites, trips, vehicles, vehicleTareHistory, weighings } from "../db/schema.js";
import { AppError, forbidden, invalidState, notFound, refused } from "../errors.js";
import { nextReportNo } from "../numbering.js";
import { type ProceedOptions, proceed, saveAndAnswer } from "../weighing/flow.js";
import { messages } from "../weighing/messages.js";
import { loadWeighContext } from "../weighing/service.js";
import { joinSpoken, type Spoken } from "../weighing/speech.js";
import { loadSteps, readyStep, repeatLoading } from "../weighing/steps.js";
import { loadWeighTrip, weighingView } from "../weighing/view.js";
import { contextOf, decisionOf, type ExceptionRow, expireStaleExceptions, pendingSpoken } from "./service.js";

/** The three weight differences: a written reason is required and an approval gets a Berita Acara number. */
export const DIFFERENCE_TYPES = ["GROSS_IN", "TARE_OUT", "NET_IN"];
const REPORT_KIND: Record<string, string> = { GROSS_IN: "SELISIH-BRUTO", TARE_OUT: "SELISIH-TARRA", NET_IN: "SELISIH-NETTO" };
export const REPORT_TITLE: Record<string, string> = { GROSS_IN: "Berita Acara Selisih Bruto", TARE_OUT: "Berita Acara Selisih Tarra", NET_IN: "Berita Acara Selisih Netto" };

export const decideBody = z.object({
  decision: z.enum(["APPROVE", "REJECT", "OK", "ADD_LOAD", "REDUCE_LOAD"], "Keputusan harus APPROVE, REJECT, OK, ADD_LOAD, atau REDUCE_LOAD."),
  reason: z.string("Alasan harus berupa teks.").trim().max(500, "Alasan terlalu panjang.").optional(),
  updateMasterTare: z.boolean("updateMasterTare harus true atau false.").optional(),
});
export type DecideBody = z.infer<typeof decideBody>;

/** The rules of the body that depend on the type of the request. */
function checkBody(row: ExceptionRow, body: DecideBody): void {
  const fields: { field: string; message: string }[] = [];
  const netOut = row.type === "NET_OUT";
  const allowed = netOut ? ["OK", "ADD_LOAD", "REDUCE_LOAD"] : ["APPROVE", "REJECT"];
  if (!allowed.includes(body.decision)) fields.push({ field: "decision", message: netOut ? "Keputusan harus OK, ADD_LOAD, atau REDUCE_LOAD." : "Keputusan harus APPROVE atau REJECT." });
  if (DIFFERENCE_TYPES.includes(row.type) && (body.reason ?? "").length < 3) fields.push({ field: "reason", message: "Alasan wajib diisi, minimal 3 huruf." });
  if (body.updateMasterTare && !(row.type === "TARE_OUT" && body.decision === "APPROVE")) {
    fields.push({ field: "updateMasterTare", message: "Tarra master hanya bisa diganti pada selisih tarra yang disetujui." });
  }
  if (fields.length) throw new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", fields);
}

const cancelledError = () => refused("EXCEPTION_CANCELLED", "Permintaan ini sudah dibatalkan.");
const decidedError = () => refused("ALREADY_DECIDED", "Permintaan ini sudah diputuskan.");

export interface DecideResult {
  exceptionId: number;
  weighing: ReturnType<typeof weighingView> | null;
  next: { id: number; type: string } | null;
}

export async function decideException(tx: Orm, request: FastifyRequest, account: Account, id: number, body: DecideBody, now: Date): Promise<DecideResult> {
  await expireStaleExceptions(tx, now);
  const [row] = await tx.select().from(exceptions).where(eq(exceptions.id, id)).for("update");
  if (!row) throw notFound("Permintaan");
  checkBody(row, body);
  if (row.status === "CANCELLED" || row.status === "EXPIRED") throw cancelledError();
  if (row.status !== "PENDING") throw decidedError();
  if (!can(account, row.approverModule as ModuleCode, "EDIT")) throw forbidden();
  if (row.stationId === null || row.liveWeightKg === null) throw invalidState("Permintaan ini tidak berasal dari timbangan.");

  const weigh = await loadWeighContext(tx, row.tripId, null, true);
  if (weigh.step.id !== row.tripStepId) throw invalidState("Langkah timbang truk ini sudah berubah.");
  const context = contextOf(row);
  const reason = body.reason && body.reason.length > 0 ? body.reason : null;
  const input = { stationId: row.stationId, weightKg: row.liveWeightKg, plateRead: context.plateRead, cardUid: context.cardUid, ip: request.ip };
  const options: ProceedOptions = { after: row.type as ProceedOptions["after"], plateAttempts: null, plateCheck: context.plateCheck, mode: "EXCEPTION", decidedBy: account.id };
  const decided = { decidedBy: account.id, decidedAt: now, decisionReason: reason };

  let weighingId: number | null = null;
  let next: DecideResult["next"] = null;
  let changes: Partial<typeof exceptions.$inferInsert> = {};

  if (body.decision === "REJECT") {
    changes = { status: "REJECTED", ...decided };
    await tx.update(exceptions).set(changes).where(eq(exceptions.id, id));
  } else if (body.decision === "ADD_LOAD" || body.decision === "REDUCE_LOAD") {
    changes = { status: "RETRY", decisionCode: body.decision, ...decided };
    await tx.update(exceptions).set(changes).where(eq(exceptions.id, id));
    await repeatLoading(tx, row.tripId, now);
  } else if (row.type === "PLATE") {
    // the weighing goes on with the registered plate; the checks after the plate still run
    changes = { status: "APPROVED", ...decided };
    await tx.update(exceptions).set(changes).where(eq(exceptions.id, id));
    const answer = await proceed(tx, weigh, input, { ...options, plateCheck: "CONFIRMED" }, now);
    if (answer.result === "SAVED") weighingId = answer.weighingId;
    if (answer.result === "PENDING") {
      next = { id: answer.exceptionId, type: (answer.body.exception as { type: string }).type };
      changes = { ...changes, context: { ...context, nextExceptionId: answer.exceptionId } };
    }
  } else {
    const [site] = await tx.select({ code: sites.code }).from(sites).where(eq(sites.id, row.siteId));
    const kind = REPORT_KIND[row.type];
    const reportNo = kind && site ? await nextReportNo(tx, kind, site.code, now) : null;
    changes = { status: "APPROVED", ...(row.type === "NET_OUT" ? { decisionCode: "OK" as const } : {}), reportNo, ...decided };
    await tx.update(exceptions).set(changes).where(eq(exceptions.id, id));
    const { weighing } = await saveAndAnswer(tx, weigh, input, options, now);
    weighingId = weighing.id;
    if (body.updateMasterTare && weigh.vehicle) {
      await tx.update(vehicles).set({ tareKg: weighing.weightKg, updatedAt: now }).where(eq(vehicles.id, weigh.vehicle.id));
      await tx.insert(vehicleTareHistory).values({ vehicleId: weigh.vehicle.id, tareKg: weighing.weightKg, source: "WEIGHING", weighingId: weighing.id, reason, changedBy: account.id, changedAt: now });
      changes = { ...changes, context: { ...context, masterTareUpdated: true } };
    }
  }
  if (weighingId !== null || changes.context) await tx.update(exceptions).set({ weighingId, ...(changes.context ? { context: changes.context } : {}) }).where(eq(exceptions.id, id));
  await writeAudit(tx, request, now, {
    action: "EXCEPTION_DECIDED",
    entityType: "exception",
    entityId: id,
    before: { status: row.status },
    after: { status: changes.status, decision: body.decision, reportNo: changes.reportNo ?? null, weighingId, next, updateMasterTare: body.updateMasterTare ?? false },
    ...(reason ? { reason } : {}),
  });
  const [weighing] = weighingId === null ? [] : await tx.select().from(weighings).where(eq(weighings.id, weighingId));
  return { exceptionId: id, weighing: weighing ? weighingView(weighing) : null, next };
}

/** The SAVED sentences for a weighing already saved (after an approval). */
async function savedSpoken(orm: Orm, weighing: typeof weighings.$inferSelect): Promise<Spoken> {
  const [trip] = await orm.select({ netKg: trips.netKg }).from(trips).where(eq(trips.id, weighing.tripId));
  const next = readyStep(await loadSteps(orm, weighing.tripId));
  return messages.saved({ stage: weighing.stage === 1 ? 1 : 2, kind: weighing.kind, weightKg: weighing.weightKg, netKg: trip?.netKg ?? null, next: next?.name ?? null });
}

/** What the weighbridge program is told about a request it waits on. */
export async function stationAnswer(orm: Orm, row: ExceptionRow): Promise<Record<string, unknown>> {
  const decision = decisionOf(row);
  const head = { status: row.status, ...(decision ? { decision } : {}) };
  if (row.status === "PENDING") return { status: row.status, ...messages.waiting() };
  if (row.status === "APPROVED") {
    if (row.weighingId !== null) {
      const [weighing] = await orm.select().from(weighings).where(eq(weighings.id, row.weighingId));
      if (weighing) {
        return { ...head, result: "SAVED", weighing: weighingView(weighing), trip: await loadWeighTrip(orm, row.tripId), ...joinSpoken(messages.approved(), await savedSpoken(orm, weighing)) };
      }
    }
    const nextId = contextOf(row).nextExceptionId;
    if (nextId !== undefined) {
      const [next] = await orm.select().from(exceptions).where(eq(exceptions.id, nextId));
      if (next) return { ...head, result: "PENDING", exception: { id: next.id, type: next.type }, ...joinSpoken(messages.approved(), pendingSpoken(next)) };
    }
  }
  if (row.status === "REJECTED") return { ...head, result: "NOT_SAVED", ...messages.rejected(row.type === "PLATE") };
  if (row.status === "RETRY" && (row.decisionCode === "ADD_LOAD" || row.decisionCode === "REDUCE_LOAD")) return { ...head, result: "NOT_SAVED", ...messages.retry(row.decisionCode) };
  return { ...head, result: "NOT_SAVED", ...messages.cancelled() };
}
