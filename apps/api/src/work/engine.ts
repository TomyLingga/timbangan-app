// What every phone form shares: the stored answer of a resend, the step locked with its trip, the checks of
// module, kind and state, the answer { step, trip, next }, and the pieces several forms use (closing a step,
// photos, stock seals, quality figures, document numbers, tanks).
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type Account, accountOf, can } from "../auth/guard.js";
import type { ModuleCode } from "../auth/permissions.js";
import { writeAudit } from "../audit.js";
import type { Orm } from "../db/client.js";
import {
  type FieldForm,
  fieldSubmissions,
  files,
  flowSteps,
  qualityParameters,
  registrations,
  seals,
  storageTanks,
  trips,
  tripFiles,
  tripSeals,
  tripSteps,
} from "../db/schema.js";
import { AppError, forbidden, invalid, notFound, refused, violatedUnique } from "../errors.js";
import { FIELD_DOCUMENTS, type FieldDocument, nextFieldDocumentNo } from "../numbering.js";
import { readSetting, siteById } from "../settings.js";
import { INSIDE_STATUSES } from "../trips/view.js";
import { loadSteps, readyStep } from "../weighing/steps.js";
import { loadWeighTrip } from "../weighing/view.js";
import { tripProducts } from "./view.js";

/** A form step with what the rules need about its trip. */
export interface FormStep {
  row: typeof tripSteps.$inferSelect;
  name: string;
  performerModule: string | null;
  trip: typeof trips.$inferSelect;
  flowCode: string;
  direction: "IN" | "OUT";
}

export interface FormRun {
  tx: Orm;
  account: Account;
  now: Date;
  step: FormStep;
  clientUuid: string;
}

export interface FormResult {
  /** What the audit row records besides the step. */
  audit: Record<string, unknown>;
  reason?: string | null;
  /** More keys of the answer, next to step, trip and next. */
  extra?: Record<string, unknown>;
}

export interface FormSpec<B extends { clientUuid: string }> {
  form: FieldForm;
  schema: z.ZodType<B>;
  stepCodes: string[];
  /** The flows the form serves; any flow when absent. */
  flows?: string[];
  /** Whether the step may take the form now; READY when absent. */
  ready?: (step: FormStep, body: B) => boolean;
  /** Why the step may not take the form, when `ready` says no. */
  notReadyMessage?: (step: FormStep) => string;
  run: (run: FormRun, body: B) => Promise<FormResult>;
}

export const clientUuidField = z.uuid("Nomor kiriman (clientUuid) harus berupa UUID.");
export const remarkField = z
  .string("Catatan harus berupa teks.")
  .trim()
  .max(500, "Catatan terlalu panjang.")
  .transform((text) => (text.length > 0 ? text : null))
  .optional();
export const photoIdsField = (max: number) =>
  z
    .array(z.number("Nomor foto harus angka.").int("Nomor foto harus angka.").positive("Nomor foto harus angka."), "Foto harus berupa daftar nomor.")
    .max(max, `Paling banyak ${max} foto.`)
    .optional();

/** Dates and other values as jsonb stores them, so a resend gets exactly the same body. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** A step as a form answer shows it. */
export async function formStepView(orm: Orm, stepId: number) {
  const [row] = await orm
    .select({ step: tripSteps, name: flowSteps.name })
    .from(tripSteps)
    .innerJoin(trips, eq(trips.id, tripSteps.tripId))
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .leftJoin(flowSteps, and(eq(flowSteps.siteId, trips.siteId), eq(flowSteps.flowCode, registrations.flowCode), eq(flowSteps.stepCode, tripSteps.stepCode)))
    .where(eq(tripSteps.id, stepId));
  if (!row) return null;
  const { step } = row;
  return {
    id: step.id,
    stepCode: step.stepCode,
    name: row.name ?? step.stepCode,
    status: step.status,
    result: step.result,
    attempt: step.attempt,
    readyAt: step.readyAt,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    performedBy: step.performedBy,
    note: step.note,
  };
}

/** The step and its trip, the trip locked until the transaction ends. */
async function lockFormStep(tx: Orm, stepId: number): Promise<FormStep | null> {
  const [head] = await tx.select({ tripId: tripSteps.tripId }).from(tripSteps).where(eq(tripSteps.id, stepId));
  if (!head) return null;
  const [trip] = await tx.select().from(trips).where(eq(trips.id, head.tripId)).for("update");
  if (!trip) return null;
  const [row] = await tx
    .select({ step: tripSteps, name: flowSteps.name, performerModule: flowSteps.performerModule, flowCode: registrations.flowCode, direction: registrations.direction })
    .from(tripSteps)
    .innerJoin(registrations, eq(registrations.id, trip.registrationId))
    .leftJoin(flowSteps, and(eq(flowSteps.siteId, trip.siteId), eq(flowSteps.flowCode, registrations.flowCode), eq(flowSteps.stepCode, tripSteps.stepCode)))
    .where(eq(tripSteps.id, stepId));
  if (!row) return null;
  return { row: row.step, name: row.name ?? row.step.stepCode, performerModule: row.performerModule, trip, flowCode: row.flowCode, direction: row.direction };
}

async function storedSubmission(orm: Orm, clientUuid: string) {
  const [row] = await orm.select().from(fieldSubmissions).where(eq(fieldSubmissions.clientUuid, clientUuid));
  return row ?? null;
}

/** The stored answer of a resend; a uuid sent before for another step or form is refused. */
function replay(stored: typeof fieldSubmissions.$inferSelect, stepId: number, form: FieldForm) {
  if (stored.tripStepId !== stepId || stored.form !== form) throw refused("UUID_REUSED", "Nomor kiriman ini sudah dipakai untuk form lain.");
  return stored.response;
}

/**
 * Runs one form: a resend answers what was stored; otherwise, in one transaction, the step is checked (module at
 * create level, kind, state), the form runs, and the answer is stored with the client uuid and audited.
 */
export async function runForm<B extends { clientUuid: string }>(orm: Orm, request: FastifyRequest, stepId: number, now: Date, spec: FormSpec<B>) {
  const body = spec.schema.parse(request.body ?? {});
  const account = accountOf(request);
  const known = await storedSubmission(orm, body.clientUuid);
  if (known) return replay(known, stepId, spec.form);
  try {
    return await orm.transaction(async (tx) => {
      const step = await lockFormStep(tx, stepId);
      if (!step) throw notFound("Langkah");
      if (!step.performerModule || !can(account, step.performerModule as ModuleCode, "CREATE")) throw forbidden();
      if (!spec.stepCodes.includes(step.row.stepCode) || (spec.flows && !spec.flows.includes(step.flowCode))) {
        throw refused("WRONG_STEP", `Form ini bukan untuk langkah ${step.name}.`);
      }
      const inside = INSIDE_STATUSES.includes(step.trip.status);
      const ready = spec.ready ? spec.ready(step, body) : step.row.status === "READY";
      if (!inside || !ready) {
        const message = inside && spec.notReadyMessage ? spec.notReadyMessage(step) : step.row.result === "HOLD" ? "Langkah ini menunggu keputusan QC." : "Langkah ini belum siap atau sudah selesai.";
        throw refused("NOT_READY", message);
      }
      const result = await spec.run({ tx, account, now, step, clientUuid: body.clientUuid }, body);
      const waiting = readyStep(await loadSteps(tx, step.trip.id));
      const response = asJson({
        step: await formStepView(tx, step.row.id),
        trip: await loadWeighTrip(tx, step.trip.id),
        next: waiting && waiting.id !== step.row.id ? await formStepView(tx, waiting.id) : null,
        ...result.extra,
      });
      await tx.insert(fieldSubmissions).values({ clientUuid: body.clientUuid, tripStepId: step.row.id, form: spec.form, userId: account.id, response, createdAt: now });
      await writeAudit(tx, request, now, {
        action: `FORM_${spec.form}`,
        entityType: "trip",
        entityId: step.trip.id,
        before: { step: step.row.stepCode, stepId: step.row.id, status: step.row.status, outcome: step.trip.outcome },
        after: { clientUuid: body.clientUuid, ...result.audit },
        ...(result.reason ? { reason: result.reason } : {}),
      });
      return response;
    });
  } catch (error) {
    // the same form sent twice at the same moment: the later one waits for the trip lock and then finds the step
    // done, or breaks a unique key; either way the answer stored for this uuid is the one to give
    if (error instanceof AppError || violatedUnique(error) !== null) {
      const stored = await storedSubmission(orm, body.clientUuid);
      if (stored) return replay(stored, stepId, spec.form);
    }
    throw error;
  }
}

export interface Close {
  status: "DONE" | "FAILED";
  result: "PASS" | "FAIL";
  performedBy: number | null;
  note?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date;
}

/** Finishes a step, keeping the time it was started when it has one. */
export async function closeStep(orm: Orm, step: typeof tripSteps.$inferSelect, close: Close, now: Date): Promise<void> {
  await orm
    .update(tripSteps)
    .set({
      status: close.status,
      result: close.result,
      performedBy: close.performedBy,
      note: close.note ?? null,
      startedAt: close.startedAt ?? step.startedAt ?? now,
      finishedAt: close.finishedAt ?? now,
    })
    .where(eq(tripSteps.id, step.id));
}

/** Attaches uploaded photos to the trip; each photo belongs to one form only. */
export async function attachPhotos(orm: Orm, tripId: number, fileIds: number[] | undefined, stepCode: string, label: string): Promise<void> {
  if (!fileIds?.length) return;
  const unique = [...new Set(fileIds)];
  const found = await orm.select({ id: files.id, kind: files.kind }).from(files).where(inArray(files.id, unique));
  const linked = await orm.select({ fileId: tripFiles.fileId }).from(tripFiles).where(inArray(tripFiles.fileId, unique));
  for (const id of unique) {
    if (!found.some((row) => row.id === id && row.kind === "PHOTO")) throw invalid("photoFileIds", `Foto ${id} tidak ditemukan.`);
    if (linked.some((row) => row.fileId === id)) throw invalid("photoFileIds", `Foto ${id} sudah dipakai.`);
  }
  await orm.insert(tripFiles).values(unique.map((fileId) => ({ tripId, fileId, stepCode, label })));
}

/** One to four stock seals, each once, with where each one goes. */
export const sealsField = z
  .array(
    z.object({
      sealId: z.number("Segel harus berupa id.").int("Segel harus berupa id.").positive("Segel harus berupa id."),
      position: z
        .string("Posisi segel harus berupa teks.")
        .trim()
        .max(50, "Posisi segel terlalu panjang.")
        .transform((text) => (text.length > 0 ? text : null))
        .optional(),
    }),
    "Pilih 1 sampai 4 segel.",
  )
  .min(1, "Pilih 1 sampai 4 segel.")
  .max(4, "Pilih 1 sampai 4 segel.")
  .refine((items) => new Set(items.map((item) => item.sealId)).size === items.length, "Segel yang sama dipilih dua kali.");

/** Puts available stock seals of the trip's site on the truck; they become USED. */
export async function applySeals(run: FormRun, items: { sealId: number; position?: string | null }[]): Promise<string[]> {
  const { tx, step, account, now } = run;
  const rows = await tx.select().from(seals).where(inArray(seals.id, items.map((item) => item.sealId))).for("update");
  const numbers: string[] = [];
  for (const [index, item] of items.entries()) {
    const seal = rows.find((row) => row.id === item.sealId);
    if (!seal || seal.siteId !== step.trip.siteId) throw invalid(`seals.${index}.sealId`, "Segel tidak ditemukan.");
    if (seal.status !== "AVAILABLE") throw refused("SEAL_NOT_AVAILABLE", `Segel ${seal.sealNo} sudah terpakai atau dibatalkan.`);
    numbers.push(seal.sealNo);
  }
  await tx.insert(tripSeals).values(
    items.map((item) => {
      const seal = rows.find((row) => row.id === item.sealId);
      return {
        tripId: step.trip.id,
        sealNo: seal?.sealNo ?? "",
        kind: seal?.kind ?? ("LOCIS" as const),
        origin: "APPLIED" as const,
        position: item.position ?? null,
        sealId: item.sealId,
        appliedBy: account.id,
        appliedAt: now,
        tripStepId: step.row.id,
      };
    }),
  );
  await tx.update(seals).set({ status: "USED" }).where(inArray(seals.id, items.map((item) => item.sealId)));
  return numbers;
}

/** Applied seals still on the truck. */
export async function appliedSealsInPlace(orm: Orm, tripId: number) {
  return orm
    .select()
    .from(tripSeals)
    .where(and(eq(tripSeals.tripId, tripId), eq(tripSeals.origin, "APPLIED"), isNull(tripSeals.removedAt)))
    .orderBy(asc(tripSeals.id));
}

/** A quality figure of a form: required or optional, never below zero. */
export const valueField = (code: string) =>
  z.number({ error: (issue) => (issue.input === undefined ? `${code} wajib diisi.` : `${code} harus angka.`) }).min(0, `${code} tidak boleh negatif.`);

/** Refuses figures outside the plausibility range of their parameter, field by field. */
export async function checkPlausible(orm: Orm, values: Record<string, number | undefined>): Promise<[string, number][]> {
  const given = Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined);
  if (given.length === 0) return [];
  const rows = await orm.select().from(qualityParameters).where(inArray(qualityParameters.code, given.map(([code]) => code)));
  const problems: { field: string; message: string }[] = [];
  for (const [code, value] of given) {
    const row = rows.find((item) => item.code === code);
    if (!row) problems.push({ field: `values.${code}`, message: `Parameter ${code} tidak dikenal.` });
    else if (!row.isActive) problems.push({ field: `values.${code}`, message: `${row.name} belum dipakai.` });
    else if (value < row.minValid || value > row.maxValid) problems.push({ field: `values.${code}`, message: `${row.name} harus antara ${row.minValid} dan ${row.maxValid}.` });
  }
  if (problems.length) throw new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", problems);
  return given;
}

/** The next number of a field document for the trip's site, in the pattern of its setting. */
export async function issueDocumentNo(orm: Orm, document: FieldDocument, siteId: number, now: Date): Promise<string> {
  const format = await readSetting<string>(orm, siteId, FIELD_DOCUMENTS[document].setting);
  const site = await siteById(orm, siteId);
  return nextFieldDocumentNo(orm, document, typeof format === "string" ? format : null, site.code, now);
}

/** An active tank of the trip's site that may take the trip's product (a tank without a product takes any). */
export async function tankFor(orm: Orm, step: FormStep, tankId: number, field: string): Promise<typeof storageTanks.$inferSelect> {
  const [tank] = await orm.select().from(storageTanks).where(and(eq(storageTanks.id, tankId), eq(storageTanks.siteId, step.trip.siteId), eq(storageTanks.isActive, true)));
  if (!tank) throw invalid(field, "Tangki tidak ditemukan atau tidak aktif.");
  if (tank.productId !== null) {
    const productIds = (await tripProducts(orm, [step.trip.id])).get(step.trip.id)?.map((item) => item.id) ?? [];
    if (!productIds.includes(tank.productId)) throw invalid(field, "Tangki ini bukan untuk produk truk ini.");
  }
  return tank;
}

/** The latest attempt of a step of the trip. */
export async function latestStep(orm: Orm, tripId: number, stepCode: string) {
  const [row] = await orm
    .select()
    .from(tripSteps)
    .where(and(eq(tripSteps.tripId, tripId), eq(tripSteps.stepCode, stepCode)))
    .orderBy(desc(tripSteps.attempt))
    .limit(1);
  return row ?? null;
}
