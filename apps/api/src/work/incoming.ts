// The forms of the incoming CPO flow: seal check on arrival, QC at receiving, reseal of a rejected truck, and
// unloading, which also completes the tank-empty check (docs/fase-5-rancangan.md, section 3).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { exceptions, handlings, inspections, qualityChecks, qualityValues, trips, tripSteps } from "../db/schema.js";
import { findRule } from "../weighing/rules.js";
import { advance, outcomeOf, rejectTrip } from "../weighing/steps.js";
import {
  applySeals,
  attachPhotos,
  checkFormValues,
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

// --- seal check ---

const sealCheckBody = z
  .object({
    clientUuid: clientUuidField,
    seals: z
      .array(
        z.object({
          sealNo: z.string("Nomor segel wajib diisi.").trim().toUpperCase().min(1, "Nomor segel wajib diisi.").max(30, "Nomor segel terlalu panjang."),
          intact: z.boolean("Keadaan segel (utuh atau tidak) wajib diisi."),
          note: z.string("Catatan segel harus berupa teks.").trim().max(200, "Catatan segel terlalu panjang.").optional(),
        }),
        "Isi paling sedikit satu segel.",
      )
      .min(1, "Isi paling sedikit satu segel.")
      .max(10, "Paling banyak 10 segel."),
    result: z.enum(["PASS", "FAIL"], "Hasil harus PASS atau FAIL."),
    remark: remarkField,
    photoFileIds: photoIdsField(5),
  })
  .superRefine((body, issues) => {
    const seen = new Set<string>();
    for (const seal of body.seals) {
      if (seen.has(seal.sealNo)) {
        issues.addIssue({ code: "custom", path: ["seals"], message: `Nomor segel ${seal.sealNo} tertulis dua kali.` });
        break;
      }
      seen.add(seal.sealNo);
    }
    if (body.result === "FAIL" && !body.remark) issues.addIssue({ code: "custom", path: ["remark"], message: "Catatan wajib diisi bila hasilnya gagal." });
  });

export const sealCheckForm: FormSpec<z.infer<typeof sealCheckBody>> = {
  form: "SEAL_CHECK",
  schema: sealCheckBody,
  stepCodes: ["SEAL_CHECK"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const pass = body.result === "PASS";
    await tx.insert(inspections).values({
      tripId: step.trip.id,
      tripStepId: step.row.id,
      kind: "SEAL_CHECK",
      result: body.result,
      checklist: body.seals.map((seal) => ({ key: "seal", item: `Segel ${seal.sealNo}`, value: seal.sealNo, ok: seal.intact, note: seal.note || null })),
      performedBy: account.id,
      performedAt: now,
      remark: body.remark ?? null,
      clientUuid: run.clientUuid,
    });
    await attachPhotos(tx, step.trip.id, body.photoFileIds, "SEAL_CHECK", "seal_check");
    await closeStep(tx, step.row, { status: pass ? "DONE" : "FAILED", result: body.result, performedBy: account.id, note: body.remark ?? null }, now);
    if (pass) await advance(tx, step.trip.id, now);
    else await rejectTrip(tx, step.trip.id, outcomeOf("SEAL_CHECK"), now);
    return { audit: { result: body.result, seals: body.seals.map((seal) => seal.sealNo) }, reason: body.remark ?? null };
  },
};

// --- QC at receiving ---

const RECEIVING_REASONS = ["FFA_OUT", "MI_OUT", "FFA_MI_OUT"] as const;

const qcReceivingBody = z
  .object({
    clientUuid: clientUuidField,
    // which figures are required follows the active parameters (checkFormValues), as the work view offers them
    values: z.object(
      { FFA: valueField("FFA").optional(), MOISTURE: valueField("MOISTURE").optional(), IMPURITIES: valueField("IMPURITIES").optional() },
      "Angka mutu wajib diisi.",
    ),
    disposition: z.enum(["OK", "HOLD", "NOT_OK"], "Disposisi harus OK, HOLD, atau NOT_OK."),
    reasonCode: z.enum(RECEIVING_REASONS, `Keterangan harus salah satu dari ${RECEIVING_REASONS.join(", ")}.`).optional(),
    remark: remarkField,
  })
  .superRefine((body, issues) => {
    if (body.disposition !== "OK" && !body.reasonCode) issues.addIssue({ code: "custom", path: ["reasonCode"], message: "Keterangan wajib dipilih bila disposisi bukan OK." });
    if (body.disposition === "OK" && body.reasonCode) issues.addIssue({ code: "custom", path: ["reasonCode"], message: "Keterangan hanya diisi bila disposisi bukan OK." });
  });

/** The module that decides a QC hold when no exception rule names one. */
const QC_DECIDER = "qc_approvals";

export const qcReceivingForm: FormSpec<z.infer<typeof qcReceivingBody>> = {
  form: "QC_RECEIVING",
  schema: qcReceivingBody,
  stepCodes: ["QC"],
  flows: ["IN_CPO"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const values = await checkFormValues(tx, step.flowCode, "QC", body.values);
    const ok = body.disposition === "OK";
    const [check] = await tx
      .insert(qualityChecks)
      .values({
        tripId: step.trip.id,
        tripStepId: step.row.id,
        stage: "RECEIVING",
        sampledBy: account.id,
        sampledAt: now,
        decision: ok ? "PASS" : "HOLD",
        decidedBy: ok ? account.id : null,
        decidedAt: ok ? now : null,
        disposition: body.disposition,
        reasonCode: body.reasonCode ?? null,
        remark: body.remark ?? null,
        clientUuid: run.clientUuid,
      })
      .returning({ id: qualityChecks.id });
    if (!check) throw new Error("The quality check was not saved.");
    await tx.insert(qualityValues).values(values.map(([parameterCode, value]) => ({ parameterCode, value, source: "QC" as const, qualityCheckId: check.id })));

    if (ok) {
      await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null }, now);
      await advance(tx, step.trip.id, now);
      return { audit: { qualityCheckId: check.id, disposition: body.disposition, values: body.values }, extra: { exception: null } };
    }
    // the truck waits at QC until a QC supervisor decides
    await tx
      .update(tripSteps)
      .set({ status: "IN_PROGRESS", result: "HOLD", performedBy: account.id, startedAt: step.row.startedAt ?? now, note: body.remark ?? null })
      .where(eq(tripSteps.id, step.row.id));
    const rule = await findRule(tx, step.trip.siteId, "QC_HOLD", step.flowCode, now);
    const [raised] = await tx
      .insert(exceptions)
      .values({
        siteId: step.trip.siteId,
        tripId: step.trip.id,
        tripStepId: step.row.id,
        qualityCheckId: check.id,
        type: "QC_HOLD",
        status: "PENDING",
        context: {
          plateNo: step.trip.plateNo,
          disposition: body.disposition,
          reasonCode: body.reasonCode ?? null,
          values: body.values,
          remark: body.remark ?? null,
        },
        approverModule: rule?.approverModule ?? QC_DECIDER,
        raisedAt: now,
      })
      .returning({ id: exceptions.id, type: exceptions.type });
    if (!raised) throw new Error("The QC hold was not raised.");
    return {
      audit: { qualityCheckId: check.id, disposition: body.disposition, reasonCode: body.reasonCode, values: body.values, exceptionId: raised.id },
      reason: body.remark ?? null,
      extra: { exception: raised },
    };
  },
};

// --- reseal of a rejected truck ---

const resealBody = z.object({ clientUuid: clientUuidField, seals: sealsField, remark: remarkField });

export const resealForm: FormSpec<z.infer<typeof resealBody>> = {
  form: "RESEAL",
  schema: resealBody,
  stepCodes: ["RESEAL"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const numbers = await applySeals(run, body.seals);
    const letterNo = step.trip.outSpecLetterNo ?? (await issueDocumentNo(tx, "OS", step.trip.siteId, now));
    if (step.trip.outSpecLetterNo === null) await tx.update(trips).set({ outSpecLetterNo: letterNo, updatedAt: now }).where(eq(trips.id, step.trip.id));
    await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null }, now);
    await advance(tx, step.trip.id, now);
    return { audit: { seals: numbers, outSpecLetterNo: letterNo }, reason: body.remark ?? null, extra: { outSpecLetterNo: letterNo } };
  },
};

// --- unloading, with the tank-empty check ---

const yes = (label: string) => z.boolean(`${label} wajib diisi.`);
const unloadingBody = z.object({
  clientUuid: clientUuidField,
  tankId: z.number("Tangki wajib dipilih.").int("Tangki wajib dipilih.").positive("Tangki wajib dipilih."),
  doorNo: z.number("Nomor pintu wajib diisi.").int("Nomor pintu 1 sampai 10.").min(1, "Nomor pintu 1 sampai 10.").max(10, "Nomor pintu 1 sampai 10."),
  // true = found in the cargo
  wood: yes("Kayu"),
  wire: yes("Kawat"),
  plastic: yes("Plastik"),
  handbrakeOn: yes("Rem tangan"),
  engineOn: yes("Mesin"),
  manholeOpen: yes("Mainhole"),
  dischargeValveActive: yes("Discharge valve"),
  tankEmpty: z.literal(true, "Tangki truk harus kosong sebelum bongkar disimpan."),
  remark: remarkField,
  photoFileIds: photoIdsField(3),
});

export const unloadingForm: FormSpec<z.infer<typeof unloadingBody>> = {
  form: "UNLOADING",
  schema: unloadingBody,
  stepCodes: ["UNLOADING"],
  flows: ["IN_CPO"],
  run: async (run, body) => {
    const { tx, step, account, now } = run;
    const tank = await tankFor(tx, step, body.tankId, "tankId");
    const logSheet = {
      doorNo: body.doorNo,
      wood: body.wood,
      wire: body.wire,
      plastic: body.plastic,
      handbrakeOn: body.handbrakeOn,
      engineOn: body.engineOn,
      manholeOpen: body.manholeOpen,
      dischargeValveActive: body.dischargeValveActive,
      tankEmpty: body.tankEmpty,
    };
    await tx.insert(handlings).values({
      tripId: step.trip.id,
      tripStepId: step.row.id,
      kind: "UNLOAD",
      tankId: tank.id,
      finishedAt: now,
      operatorId: account.id,
      logSheet,
      remark: body.remark ?? null,
      clientUuid: run.clientUuid,
    });
    await attachPhotos(tx, step.trip.id, body.photoFileIds, "UNLOADING", "unloading");
    await closeStep(tx, step.row, { status: "DONE", result: "PASS", performedBy: account.id, note: body.remark ?? null }, now);
    // the tank-empty check is the tick on this form
    const tankCheck = await latestStep(tx, step.trip.id, "TANK_CHECK");
    if (tankCheck && (tankCheck.status === "PENDING" || tankCheck.status === "READY")) {
      await tx.insert(inspections).values({
        tripId: step.trip.id,
        tripStepId: tankCheck.id,
        kind: "TANK_EMPTY",
        result: "PASS",
        checklist: [{ key: "tankEmpty", item: "Tangki truk kosong", ok: true }],
        performedBy: account.id,
        performedAt: now,
      });
      await closeStep(tx, tankCheck, { status: "DONE", result: "PASS", performedBy: account.id }, now);
    }
    await advance(tx, step.trip.id, now);
    return { audit: { tank: tank.code, logSheet }, reason: body.remark ?? null };
  },
};
