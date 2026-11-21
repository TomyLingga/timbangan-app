// What happens to a trip inside the plant, outside the weighbridge program: its steps, the simple completion
// of a field step with the rejection rule, and the manual net split.
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, can, type Guards } from "../auth/guard.js";
import type { ModuleCode } from "../auth/permissions.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import { tripAllocations, trips } from "../db/schema.js";
import { forbidden, invalid, invalidState, notFound, refused } from "../errors.js";
import { idParams } from "../http.js";
import { formatKg } from "../weighing/speech.js";
import { advance, finishStep, loadSteps, outcomeOf, rejectTrip, type StepInfo } from "../weighing/steps.js";
import { allocationView, loadAllocations, loadWeighings, loadWeighTrip, uomOf, weighingView } from "../weighing/view.js";

const splitBody = z.object({
  allocations: z
    .array(
      z.object({
        seq: z.number("Urutan alokasi harus angka.").int().positive(),
        netKg: z.number("Bagian netto harus angka.").int("Bagian netto harus kilogram bulat.").min(0, "Bagian netto tidak boleh negatif."),
        qtyActual: z.number("Realisasi harus angka.").min(0, "Realisasi tidak boleh negatif.").optional(),
      }),
      "Pembagian wajib diisi.",
    )
    .min(1, "Pembagian wajib diisi."),
});

const completeBody = z.object({
  result: z.enum(["PASS", "FAIL"], "Hasil harus PASS atau FAIL."),
  note: z.string("Catatan harus berupa teks.").trim().max(500, "Catatan terlalu panjang.").optional(),
  // counted quantity per allocation, for a unit other than kilograms (loading)
  qtyActual: z
    .array(z.object({ seq: z.number("Urutan alokasi harus angka.").int().positive(), qty: z.number("Jumlah harus angka.").min(0, "Jumlah tidak boleh negatif.") }), "qtyActual harus berupa daftar.")
    .optional(),
});
const stepParams = z.object({ id: idParams.shape.id, stepCode: z.string().trim().toUpperCase().max(30) });

const stepView = (step: StepInfo) => ({
  stepCode: step.stepCode,
  name: step.name,
  seq: step.seq,
  attempt: step.attempt,
  status: step.status,
  result: step.result,
  performerModule: step.performerModule,
  isOptional: step.isOptional,
  onReject: step.onReject,
  readyAt: step.readyAt,
  finishedAt: step.finishedAt,
  performedBy: step.performedBy,
  stationId: step.stationId,
  note: step.note,
});

export function registerTripWorkRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const staff = { preHandler: [guards.authenticate, guards.requireInternal] };

  const tripExists = async (db: Orm, id: number, lock: boolean) => {
    const query = db.select().from(trips).where(eq(trips.id, id));
    const [trip] = lock ? await query.for("update") : await query;
    if (!trip) throw notFound("Trip");
    return trip;
  };

  app.get("/api/trips/:id/steps", staff, async (request) => {
    const { id } = idParams.parse(request.params);
    await tripExists(orm, id, false);
    return {
      trip: await loadWeighTrip(orm, id),
      steps: (await loadSteps(orm, id)).map(stepView),
      weighings: (await loadWeighings(orm, [id])).map(weighingView),
    };
  });

  // the simple form of a field step until the phase 5 forms: done or rejected, with a note
  app.post("/api/trips/:id/steps/:stepCode/complete", staff, async (request) => {
    const { id, stepCode } = stepParams.parse(request.params);
    const body = completeBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const steps = await orm.transaction(async (tx) => {
      const trip = await tripExists(tx, id, true);
      const step = (await loadSteps(tx, id)).find((item) => item.stepCode === stepCode);
      if (!step) throw notFound("Langkah");
      if (step.stepCode === "WEIGH_1" || step.stepCode === "WEIGH_2") throw refused("STEP_AT_WEIGHBRIDGE", "Langkah timbang dikerjakan di timbangan.");
      if (step.stepCode === "CHECK_OUT") throw refused("USE_CHECK_OUT", "Kartu dikembalikan lewat pos registrasi.");
      if (!step.performerModule || !can(account, step.performerModule as ModuleCode, "CREATE")) throw forbidden();
      if (step.status !== "READY" && step.status !== "IN_PROGRESS") throw refused("NOT_READY", "Langkah ini belum siap atau sudah selesai.");
      if (body.qtyActual?.length) {
        const rows = await loadAllocations(tx, id);
        for (const line of body.qtyActual) {
          const row = rows.find((item) => item.seq === line.seq);
          if (!row) throw invalid("qtyActual", `Alokasi ${line.seq} tidak ada pada truk ini.`);
          await tx.update(tripAllocations).set({ qtyActual: line.qty }).where(eq(tripAllocations.id, row.id));
        }
      }
      const note = body.note && body.note.length > 0 ? body.note : null;
      if (body.result === "PASS") {
        await finishStep(tx, step.id, { status: "DONE", result: "PASS", performedBy: account.id, note }, now);
        await advance(tx, id, now);
      } else {
        await finishStep(tx, step.id, { status: "FAILED", result: "FAIL", performedBy: account.id, note }, now);
        await rejectTrip(tx, id, outcomeOf(step.stepCode), now);
      }
      await writeAudit(tx, request, now, {
        action: body.result === "PASS" ? "STEP_DONE" : "STEP_REJECTED",
        entityType: "trip",
        entityId: id,
        before: { step: step.stepCode, status: step.status, outcome: trip.outcome },
        after: { step: step.stepCode, result: body.result, qtyActual: body.qtyActual ?? null },
        ...(note ? { reason: note } : {}),
      });
      return (await loadSteps(tx, id)).map(stepView);
    });
    return { trip: await loadWeighTrip(orm, id), steps };
  });

  // the logistics admin corrects the split before the card is returned; the sum stays the truck's net
  app.put("/api/trips/:id/split", { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("registrations", "EDIT")] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = splitBody.parse(request.body ?? {});
    const account = accountOf(request);
    const now = context.now();
    const allocations = await orm.transaction(async (tx) => {
      const [trip] = await tx.select().from(trips).where(eq(trips.id, id)).for("update");
      if (!trip) throw notFound("Trip");
      if (trip.status !== "IN_PROCESS" || trip.netKg === null) throw invalidState("Pembagian netto hanya bisa diubah setelah timbang kedua dan sebelum kartu dikembalikan.");
      const rows = await loadAllocations(tx, id);
      const bySeq = new Map(body.allocations.map((line) => [line.seq, line]));
      if (bySeq.size !== body.allocations.length || rows.length !== bySeq.size || rows.some((row) => !bySeq.has(row.seq))) {
        throw invalid("allocations", "Setiap alokasi truk harus diberi tepat satu bagian.");
      }
      const total = body.allocations.reduce((sum, line) => sum + line.netKg, 0);
      if (total !== trip.netKg) throw invalid("allocations", `Jumlah pembagian harus sama dengan netto truk (${formatKg(trip.netKg)} kg).`);
      const before = rows.map(allocationView);
      for (const row of rows) {
        const line = bySeq.get(row.seq);
        if (!line) continue;
        const qtyActual = uomOf(row) === "kg" ? line.netKg : (line.qtyActual ?? row.qtyActual);
        await tx.update(tripAllocations).set({ netKg: line.netKg, qtyActual, splitMethod: "MANUAL", splitBy: account.id, splitAt: now }).where(eq(tripAllocations.id, row.id));
      }
      const after = (await loadAllocations(tx, id)).map(allocationView);
      await writeAudit(tx, request, now, { action: "NET_SPLIT_CHANGED", entityType: "trip", entityId: id, before, after });
      return after;
    });
    return { allocations };
  });
}
