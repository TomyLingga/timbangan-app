// The forms of the outgoing flows: cleanliness before loading, QC loading with the certificate number,
// loading (start and finish, with the delivery note number) and sealing (docs/fase-5-rancangan.md, section 3).
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { handlings, inspections, qualityChecks, qualityValues, trips, tripSeals, tripSteps } from "../db/schema.js";
import { AppError, invalid, refused } from "../errors.js";
import { advance, outcomeOf, rejectTrip } from "../weighing/steps.js";
import {
  appliedSealsInPlace,
  applySeals,
  attachPhotos,
  checkFormValues,
  fieldTime,
  clientUuidField,
  closeStep,
  type FormSpec,
  issueDocumentNo,
  latestStep,
  photoIdsField,
  remarkField,
  sealsField,
  tankFor,
  valueField,
} from "./engine.js";

const yes = (label: string) => z.boolean(`${label} wajib diisi.`);

// --- cleanliness ---

/** The checklist of the old form, with the labels the operator reads. true = OK. */
const CLEANLINESS_ITEMS = [
  ["containerClean", "Kontainer bersih atau kosong dari sisa produk sebelumnya"],
  ["noLiquid", "Genangan minyak/air/cairan chemical, dan atau sejenisnya"],
  ["noForeignObject", "Benda asing/Pasir/Karat/Kotoran"],
  ["noPestOrNajis", "Pest dan najis atau segalanya"],
  ["wallsCleanDryNoLeak", "Dinding kontainer dalam keadaan bersih, kering dan tidak bocor"],
  ["noOdor", "Tidak ada bau yang dapat mempengaruhi mutu produk yang akan diisi di kontainer"],
] as const;
/** Required for bulk loading only. */
const NOZZLE_ITEMS = [
  ["flashLight", "Monitoring Flash Light"],
  ["nozzleVisual", "Nozzle Visual"],
  ["nozzleOdor", "Nozzle Odor"],
] as const;
const NOZZLE_NO_LABEL = "Number Nozzle Loading";

const cleanlinessBody = z.object({
  clientUuid: clientUuidField,
  items: z.object(
    {
      ...Object.fromEntries(CLEANLINESS_ITEMS.map(([key, label]) => [key, yes(label)])),
      ...Object.fromEntries(NOZZLE_ITEMS.map(([key, label]) => [key, yes(label).optional()])),
    } as Record<(typeof CLEANLINESS_ITEMS)[number][0], z.ZodBoolean> & Record<(typeof NOZZLE_ITEMS)[number][0], z.ZodOptional<z.ZodBoolean>>,
    "Butir pemeriksaan wajib diisi.",
  ),
  nozzleNo: z.number("Nomor nozzle 1 sampai 4.").int("Nomor nozzle 1 sampai 4.").min(1, "Nomor nozzle 1 sampai 4.").max(4, "Nomor nozzle 1 sampai 4.").optional(),
  disposition: z.enum(["OK", "NOT_OK"], "Disposisi harus OK atau NOT_OK."),
  conclusion: remarkField,
});

export const cleanlinessForm: FormSpec<z.infer<typeof cleanlinessBody>> = {
  form: "CLEANLINESS",
  schema: cleanlinessBody,
  stepCodes: ["CLEANLINESS"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const items = body.items as Record<string, boolean | undefined>;
    if (step.flowCode === "OUT_BULK") {
      const missing = NOZZLE_ITEMS.filter(([key]) => items[key] === undefined).map(([key, label]) => ({ field: `items.${key}`, message: `${label} wajib diisi untuk muatan curah.` }));
      if (body.nozzleNo === undefined) missing.push({ field: "nozzleNo", message: `${NOZZLE_NO_LABEL} wajib diisi untuk muatan curah.` });
      if (missing.length) throw new AppError(400, "VALIDATION", "Data yang dikirim tidak valid.", missing);
    }
    // every item is kept, whatever the disposition
    const checklist: { key: string; item: string; ok?: boolean; value?: unknown }[] = [...CLEANLINESS_ITEMS, ...NOZZLE_ITEMS]
      .filter(([key]) => items[key] !== undefined)
      .map(([key, label]) => ({ key, item: label, ok: items[key] === true }));
    if (body.nozzleNo !== undefined) checklist.push({ key: "nozzleNo", item: NOZZLE_NO_LABEL, value: body.nozzleNo });
    const ok = body.disposition === "OK";
    await tx.insert(inspections).values({
      tripId: step.trip.id,
      tripStepId: step.row.id,
      kind: "CLEANLINESS",
      result: ok ? "PASS" : "FAIL",
      checklist,
      performedBy: account.id,
      performedAt: now,
      remark: body.conclusion ?? null,
      clientUuid: run.clientUuid,
    });
    await closeStep(tx, step.row, { status: ok ? "DONE" : "FAILED", result: ok ? "PASS" : "FAIL", performedBy: account.id, note: body.conclusion ?? null }, now);
    if (ok) await advance(tx, step.trip.id, now);
    else await rejectTrip(tx, step.trip.id, outcomeOf("CLEANLINESS"), now);
    return { audit: { disposition: body.disposition, items, nozzleNo: body.nozzleNo ?? null }, reason: body.conclusion ?? null };
  },
};

// --- QC loading ---

// Only FFA is required. The others are taken when their parameter is switched on (quality_parameters.is_active);
// for now only moisture and impurities are (owner's decision, 21 November 2026).
const LOADING_OPTIONAL = ["MOISTURE", "IMPURITIES", "MNI", "IV", "LOVIBOND", "MELTING_POINT", "CLOUD_POINT", "SAPONIFIABLE", "PEROXIDE", "SMOKE_POINT"] as const;
const tankIdField = (label: string) => z.number(`${label} wajib dipilih.`).int(`${label} wajib dipilih.`).positive(`${label} wajib dipilih.`);

const qcLoadingBody = z
  .object({
    clientUuid: clientUuidField,
    values: z.object(
      {
        // FFA is required while it is switched on (checkFormValues), as the work view offers it
        FFA: valueField("FFA").optional(),
        ...Object.fromEntries(LOADING_OPTIONAL.map((code) => [code, valueField(code).optional()])),
      } as { FFA: z.ZodOptional<z.ZodNumber> } & Record<(typeof LOADING_OPTIONAL)[number], z.ZodOptional<z.ZodNumber>>,
      "Angka mutu wajib diisi.",
    ),
    tankId: tankIdField("Tangki"),
    blendTankId: tankIdField("Tangki blend").optional(),
    remark: remarkField,
  })
  .superRefine((body, issues) => {
    if (body.blendTankId !== undefined && body.blendTankId === body.tankId) {
      issues.addIssue({ code: "custom", path: ["blendTankId"], message: "Tangki blend harus berbeda dari tangki." });
    }
  });

export const qcLoadingForm: FormSpec<z.infer<typeof qcLoadingBody>> = {
  form: "QC_LOADING",
  schema: qcLoadingBody,
  stepCodes: ["QC_LOADING"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const values = await checkFormValues(tx, step.flowCode, "QC_LOADING", body.values as Record<string, number | undefined>);
    const tank = await tankFor(tx, step, body.tankId, "tankId");
    const blend = body.blendTankId === undefined ? null : await tankFor(tx, step, body.blendTankId, "blendTankId");
    const certificateNo = await issueDocumentNo(tx, "COA", step.trip.siteId, now);
    const [check] = await tx
      .insert(qualityChecks)
      .values({
        tripId: step.trip.id,
        tripStepId: step.row.id,
        stage: "LOADING",
        tankId: tank.id,
        sampledBy: account.id,
        sampledAt: now,
        certificateNo,
        remark: body.remark ?? null,
        clientUuid: run.clientUuid,
      })
      .returning({ id: qualityChecks.id });
    if (!check) throw new Error("The quality check was not saved.");
    await tx.insert(qualityValues).values(values.map(([parameterCode, value]) => ({ parameterCode, value, source: "QC" as const, qualityCheckId: check.id })));
    // one prepared loading row per tank; the loading form fills them
    const loading = await latestStep(tx, step.trip.id, "LOADING");
    await tx.insert(handlings).values(
      [tank, ...(blend ? [blend] : [])].map((item) => ({ tripId: step.trip.id, tripStepId: loading?.id ?? null, kind: "LOAD" as const, tankId: item.id, operatorId: account.id })),
    );
    await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null }, now);
    await advance(tx, step.trip.id, now);
    return { audit: { qualityCheckId: check.id, certificateNo, tank: tank.code, blendTank: blend?.code ?? null, values: body.values }, extra: { certificateNo } };
  },
};

// --- loading ---

const moment = (label: string) => z.iso.datetime({ offset: true, message: `${label} harus berupa tanggal dan jam ISO 8601.` });

const loadingStartBody = z.object({ clientUuid: clientUuidField, startedAt: moment("Waktu mulai").optional() });

export const loadingStartForm: FormSpec<z.infer<typeof loadingStartBody>> = {
  form: "LOADING_START",
  schema: loadingStartBody,
  stepCodes: ["LOADING"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const startedAt = fieldTime(body.startedAt, now, "startedAt", "Waktu mulai") ?? now;
    await tx.update(tripSteps).set({ status: "IN_PROGRESS", startedAt, performedBy: account.id }).where(eq(tripSteps.id, step.row.id));
    return { audit: { startedAt } };
  },
};

const loadingFinishBody = z.object({
  clientUuid: clientUuidField,
  temperatureC: z.number("Suhu wajib diisi.").min(0, "Suhu harus antara 0 dan 150 °C.").max(150, "Suhu harus antara 0 dan 150 °C."),
  startedAt: moment("Waktu mulai").optional(),
  finishedAt: moment("Waktu selesai").optional(),
  qualityOk: yes("Quality"),
  handbrakeOn: yes("Rem tangan"),
  engineOff: yes("Mesin"),
  remark: remarkField,
});

export const loadingFinishForm: FormSpec<z.infer<typeof loadingFinishBody>> = {
  form: "LOADING_FINISH",
  schema: loadingFinishBody,
  stepCodes: ["LOADING"],
  ready: (step, body) => step.row.status === "IN_PROGRESS" || (step.row.status === "READY" && body.startedAt !== undefined),
  notReadyMessage: (step) => (step.row.status === "READY" ? "Muat belum dimulai. Kirim waktu mulai atau tekan Mulai dulu." : "Langkah ini belum siap atau sudah selesai."),
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const startedAt = fieldTime(body.startedAt, now, "startedAt", "Waktu mulai") ?? step.row.startedAt ?? now;
    const finishedAt = fieldTime(body.finishedAt, now, "finishedAt", "Waktu selesai") ?? now;
    if (finishedAt < startedAt) throw invalid("finishedAt", "Waktu selesai tidak boleh sebelum waktu mulai.");

    // the rows QC loading prepared; a repeated loading takes the tanks of the round before; packed goods have none
    let rows = await tx.select({ id: handlings.id }).from(handlings).where(and(eq(handlings.tripStepId, step.row.id), eq(handlings.kind, "LOAD")));
    if (rows.length === 0) {
      const earlier = await tx
        .select({ tankId: handlings.tankId, tripStepId: handlings.tripStepId })
        .from(handlings)
        .where(and(eq(handlings.tripId, step.trip.id), eq(handlings.kind, "LOAD"), ne(handlings.tripStepId, step.row.id)))
        .orderBy(desc(handlings.tripStepId), handlings.id);
      const last = earlier.filter((row) => row.tripStepId === earlier[0]?.tripStepId);
      const tanks = last.length ? last.map((row) => row.tankId) : [null];
      rows = await tx
        .insert(handlings)
        .values(tanks.map((tankId) => ({ tripId: step.trip.id, tripStepId: step.row.id, kind: "LOAD" as const, tankId, operatorId: account.id })))
        .returning({ id: handlings.id });
    }
    const logSheet = { qualityOk: body.qualityOk, handbrakeOn: body.handbrakeOn, engineOff: body.engineOff };
    await tx
      .update(handlings)
      .set({ startedAt, finishedAt, temperatureC: Math.round(body.temperatureC * 10) / 10, operatorId: account.id, logSheet, remark: body.remark ?? null })
      .where(inArray(handlings.id, rows.map((row) => row.id)));
    // a repeated loading keeps the delivery note number of the first one
    const deliveryNoteNo = step.trip.deliveryNoteNo ?? (await issueDocumentNo(tx, "SJ", step.trip.siteId, now));
    if (step.trip.deliveryNoteNo === null) await tx.update(trips).set({ deliveryNoteNo, updatedAt: now }).where(eq(trips.id, step.trip.id));
    await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null, startedAt, finishedAt }, now);
    await advance(tx, step.trip.id, now);
    return { audit: { startedAt, finishedAt, temperatureC: body.temperatureC, logSheet, deliveryNoteNo }, reason: body.remark ?? null, extra: { deliveryNoteNo } };
  },
};

// --- sealing ---

const sealingBody = z.object({
  clientUuid: clientUuidField,
  seals: sealsField,
  removed: z
    .array(
      z.object({
        tripSealId: z.number("Segel lama harus berupa id.").int("Segel lama harus berupa id.").positive("Segel lama harus berupa id."),
        reason: z.string("Alasan membuka segel wajib diisi.").trim().min(1, "Alasan membuka segel wajib diisi.").max(200, "Alasan membuka segel terlalu panjang."),
      }),
      "Segel yang dibuka harus berupa daftar.",
    )
    .max(8, "Paling banyak 8 segel dibuka.")
    .optional(),
  remark: remarkField,
  photoFileIds: photoIdsField(5),
});

export const sealingForm: FormSpec<z.infer<typeof sealingBody>> = {
  form: "SEALING",
  schema: sealingBody,
  stepCodes: ["SEALING"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    // after more or less load the old seals were cut: each one still on the truck is listed as removed first
    const inPlace = await appliedSealsInPlace(tx, step.trip.id);
    const removed = body.removed ?? [];
    for (const [index, item] of removed.entries()) {
      if (!inPlace.some((seal) => seal.id === item.tripSealId)) throw invalid(`removed.${index}.tripSealId`, "Segel ini tidak terpasang pada truk ini.");
    }
    const left = inPlace.filter((seal) => !removed.some((item) => item.tripSealId === seal.id));
    if (left.length) throw refused("OLD_SEALS_IN_PLACE", `Segel lama masih terpasang: ${left.map((seal) => seal.sealNo).join(", ")}. Tandai dibuka dulu.`);
    for (const item of removed) {
      await tx.update(tripSeals).set({ removedAt: now, removeReason: item.reason, removedBy: account.id }).where(eq(tripSeals.id, item.tripSealId));
    }
    const numbers = await applySeals(run, body.seals);
    await attachPhotos(tx, step.trip.id, body.photoFileIds, "SEALING", "sealing");
    await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null }, now);
    await advance(tx, step.trip.id, now);
    return {
      audit: { seals: numbers, removed: inPlace.filter((seal) => removed.some((item) => item.tripSealId === seal.id)).map((seal) => seal.sealNo) },
      reason: body.remark ?? null,
    };
  },
};
