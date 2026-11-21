// The outgoing forms: cleanliness check, QC loading, loading (start and stop), sealing. Fields and labels from
// docs/fase-5-rancangan.md sections 2 and 3 and the old forms. The API routes do not exist yet: the bodies are
// the GUESSED shapes in src/api/types.ts.

import type { CleanlinessBody, CleanlinessItemKey, LoadingFinishBody, LoadingStartBody, QcLoadingBody, SealingBody } from "../api/types";
import { clockTime, decimal, parseDecimal } from "../lib/format";
import {
  choice,
  emptySlots,
  type Errors,
  type Field,
  type FormDefinition,
  labelOf,
  listOf,
  OK_NOT_OK,
  type OldSealRow,
  ON_OFF,
  parameterFields,
  parameterSummary,
  parameterValues,
  type Photo,
  photoSummary,
  pickedSeals,
  remarkField,
  remarkOf,
  remarkSummary,
  requireChoices,
  sealSummary,
  text,
  toneOf,
  validateParameters,
  validateStockSeals,
} from "./shared";

// --- cek kebersihan ---

export const CLEANLINESS_ITEMS: [CleanlinessItemKey, string][] = [
  ["containerClean", "Kontainer bersih atau kosong dari sisa produk sebelumnya"],
  ["noPuddles", "Genangan minyak/air/cairan chemical, dan atau sejenisnya"],
  ["noForeignMatter", "Benda asing/Pasir/Karat/Kotoran"],
  ["noPestNajis", "Pest dan najis atau sejenisnya"],
  ["wallsClean", "Dinding kontainer dalam keadaan bersih, kering dan tidak bocor"],
  ["noOdour", "Tidak ada bau yang dapat mempengaruhi mutu produk yang akan diisi di kontainer"],
];
const NOZZLE_ITEMS: [string, string][] = [
  ["flashLight", "Monitoring Flash Light"],
  ["nozzleVisual", "Nozzle Visual"],
];
export const NOZZLE_NUMBERS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: `Nozzle ${n}` }));

/** Nozzle items are asked for bulk loading only (docs: required for outgoing bulk). */
export const needsNozzle = (flowCode: string) => flowCode === "OUT_BULK";

export const cleanlinessForm: FormDefinition = {
  route: "cleanliness",
  title: "Cek kebersihan",
  submitLabel: "Periksa dan kirim",
  initial: () => ({
    ...Object.fromEntries(CLEANLINESS_ITEMS.map(([key]) => [key, null])),
    flashLight: null,
    nozzleVisual: null,
    nozzleNo: null,
    nozzleOdour: null,
    disposition: null,
    remark: "",
  }),
  fields: (_values, ctx) => [
    { kind: "section", key: "s-truck", title: "Checklist kebersihan truk" },
    ...CLEANLINESS_ITEMS.map(([key, label]): Field => ({ kind: "choice", key, label, options: OK_NOT_OK, required: true })),
    ...(needsNozzle(ctx.step.truck.flowCode)
      ? ([
          { kind: "section", key: "s-nozzle", title: "Monitoring nozzle" },
          ...NOZZLE_ITEMS.map(([key, label]): Field => ({ kind: "choice", key, label, options: OK_NOT_OK, required: true })),
          { kind: "choice", key: "nozzleNo", label: "Number Nozzle Loading", options: NOZZLE_NUMBERS, required: true, columns: 2 },
          { kind: "choice", key: "nozzleOdour", label: "Nozzle Odor", options: OK_NOT_OK, required: true },
        ] satisfies Field[])
      : []),
    { kind: "section", key: "s-decision", title: "Keputusan" },
    { kind: "choice", key: "disposition", label: "Disposisi", options: OK_NOT_OK, required: true },
    remarkField("Kesimpulan", "Kesimpulan pengecekan (tidak wajib)"),
  ],
  validate: (values, ctx) => {
    const errors: Errors = {};
    requireChoices(values, CLEANLINESS_ITEMS.map(([key]) => key), errors);
    if (needsNozzle(ctx.step.truck.flowCode)) requireChoices(values, ["flashLight", "nozzleVisual", "nozzleNo", "nozzleOdour"], errors);
    requireChoices(values, ["disposition"], errors);
    return errors;
  },
  body: (values, ctx, clientUuid): CleanlinessBody & Record<string, unknown> => ({
    clientUuid,
    items: Object.fromEntries(CLEANLINESS_ITEMS.map(([key]) => [key, choice(values, key) === "OK"])) as CleanlinessBody["items"],
    nozzle: needsNozzle(ctx.step.truck.flowCode)
      ? {
          flashLight: choice(values, "flashLight") === "OK",
          nozzleVisual: choice(values, "nozzleVisual") === "OK",
          nozzleOdour: choice(values, "nozzleOdour") === "OK",
          nozzleNo: Number(choice(values, "nozzleNo")),
        }
      : null,
    result: choice(values, "disposition") === "OK" ? "PASS" : "FAIL",
    ...remarkOf(values),
  }),
  summary: (values, ctx) => {
    const ok = (key: string) => ({ value: labelOf(OK_NOT_OK, choice(values, key)), tone: toneOf(OK_NOT_OK, choice(values, key)) });
    const disposition = choice(values, "disposition");
    return [
      ...CLEANLINESS_ITEMS.map(([key, label]) => ({ label, ...ok(key) })),
      ...(needsNozzle(ctx.step.truck.flowCode)
        ? [
            ...NOZZLE_ITEMS.map(([key, label]) => ({ label, ...ok(key) })),
            { label: "Number Nozzle Loading", value: labelOf(NOZZLE_NUMBERS, choice(values, "nozzleNo")) },
            { label: "Nozzle Odor", ...ok("nozzleOdour") },
          ]
        : []),
      { label: "Disposisi", ...ok("disposition") },
      ...(disposition === "NOT_OK" ? [{ label: "Akibat", value: "Truk ditolak dan langsung keluar", tone: "bad" as const }] : []),
      ...remarkSummary(values, "Kesimpulan"),
    ];
  },
};

// --- QC loading ---

const QC_LOADING_LABELS: Record<string, string> = { FFA: "Free Fatty Acid", MNI: "M dan I" };
export const YES_NO = [
  { value: "NO", label: "Tidak" },
  { value: "YES", label: "Ya" },
];

const tankCode = (ctx: Parameters<FormDefinition["summary"]>[1], id: string | null) => ctx.form.tanks.find((tank) => String(tank.id) === id)?.code ?? "–";

export const qcLoadingForm: FormDefinition = {
  route: "qc-loading",
  title: "QC loading",
  submitLabel: "Periksa dan kirim",
  initial: (ctx) => ({
    ...Object.fromEntries(ctx.form.parameters.map((parameter) => [`value.${parameter.code}`, ""])),
    tankId: null,
    blend: "NO",
    blendTankId: null,
    remark: "",
  }),
  fields: (values, ctx) => [
    { kind: "section", key: "s-values", title: "Hasil parameter analisa" },
    ...parameterFields(ctx.form.parameters, QC_LOADING_LABELS),
    { kind: "section", key: "s-tank", title: "Tanki" },
    { kind: "tank", key: "tankId", label: "Pilih Tanki", required: true },
    { kind: "choice", key: "blend", label: "Blend Tanki", options: YES_NO, required: true },
    ...(choice(values, "blend") === "YES" ? [{ kind: "tank" as const, key: "blendTankId", label: "Pilih Tanki Blend", required: true }] : []),
    remarkField("Keterangan", "Catatan QC loading (tidak wajib)"),
  ],
  validate: (values, ctx) => {
    const errors: Errors = {};
    validateParameters(values, ctx.form.parameters, errors, QC_LOADING_LABELS);
    if (!choice(values, "tankId")) errors.tankId = "Tangki wajib dipilih.";
    requireChoices(values, ["blend"], errors);
    if (choice(values, "blend") === "YES") {
      if (!choice(values, "blendTankId")) errors.blendTankId = "Tangki blend wajib dipilih.";
      else if (choice(values, "blendTankId") === choice(values, "tankId")) errors.blendTankId = "Tangki blend harus berbeda dari tangki utama.";
    }
    return errors;
  },
  body: (values, ctx, clientUuid): QcLoadingBody & Record<string, unknown> => ({
    clientUuid,
    values: parameterValues(values, ctx.form.parameters),
    tankId: Number(choice(values, "tankId")),
    ...(choice(values, "blend") === "YES" ? { blendTankId: Number(choice(values, "blendTankId")) } : {}),
    ...remarkOf(values),
  }),
  summary: (values, ctx) => [
    ...parameterSummary(values, ctx.form.parameters, QC_LOADING_LABELS),
    { label: "Tanki", value: tankCode(ctx, choice(values, "tankId")) },
    { label: "Blend Tanki", value: choice(values, "blend") === "YES" ? `Ya, ${tankCode(ctx, choice(values, "blendTankId"))}` : "Tidak" },
    ...remarkSummary(values, "Keterangan"),
  ],
};

// --- muat ---

export const loadingStartForm: FormDefinition = {
  route: "loading/start",
  title: "Muat: mulai",
  submitLabel: "Mulai muat",
  initial: () => ({}),
  fields: (_values, ctx) => [{ kind: "info", key: "startAt", label: "Waktu Mulai", value: `${clockTime(ctx.now)} (jam ponsel saat dikirim)` }],
  validate: () => ({}),
  body: (_values, ctx, clientUuid): LoadingStartBody & Record<string, unknown> => ({ clientUuid, startedAt: ctx.now.toISOString() }),
  summary: (_values, ctx) => [{ label: "Waktu Mulai", value: clockTime(ctx.now) }],
};

/** GUESSED plausibility range of the loading temperature; the API has no parameter row for it. */
export const TEMPERATURE_RANGE = { min: 0, max: 120 };
export const QUALITY = [
  { value: "OK", label: "OK", tone: "ok" as const },
  { value: "NOT_OK", label: "NOT OK", tone: "bad" as const },
];
const ENGINE = [
  { value: "OFF", label: "Off" },
  { value: "ON", label: "On" },
];

export const loadingFinishForm: FormDefinition = {
  route: "loading/finish",
  title: "Muat: stop",
  submitLabel: "Periksa dan stop",
  initial: () => ({ temperature: "", quality: null, handbrake: null, engine: null, remark: "" }),
  fields: (_values, ctx) => [
    { kind: "info", key: "startedAt", label: "Waktu Mulai", value: ctx.step.startedAt ? clockTime(ctx.step.startedAt) : "–" },
    { kind: "number", key: "temperature", label: "Temp.", unit: "°C", required: true, hint: `Isi ${TEMPERATURE_RANGE.min} sampai ${TEMPERATURE_RANGE.max}` },
    { kind: "choice", key: "quality", label: "Quality", options: QUALITY, required: true },
    { kind: "choice", key: "handbrake", label: "Rem Tangan", options: ON_OFF, required: true },
    { kind: "choice", key: "engine", label: "Mesin", options: ENGINE, required: true },
    remarkField("Keterangan", "Catatan loading (tidak wajib)"),
  ],
  validate: (values) => {
    const errors: Errors = {};
    const temperature = parseDecimal(text(values, "temperature"));
    if (temperature === null) errors.temperature = "Temp. wajib diisi.";
    else if (Number.isNaN(temperature)) errors.temperature = "Temp. harus angka, misalnya 45,5.";
    else if (temperature < TEMPERATURE_RANGE.min || temperature > TEMPERATURE_RANGE.max) {
      errors.temperature = `Temp. harus antara ${TEMPERATURE_RANGE.min} sampai ${TEMPERATURE_RANGE.max}.`;
    }
    requireChoices(values, ["quality", "handbrake", "engine"], errors);
    return errors;
  },
  body: (values, ctx, clientUuid): LoadingFinishBody & Record<string, unknown> => ({
    clientUuid,
    finishedAt: ctx.now.toISOString(),
    temperatureC: parseDecimal(text(values, "temperature")) ?? 0,
    qualityOk: choice(values, "quality") === "OK",
    handbrakeOn: choice(values, "handbrake") === "ON",
    engineOn: choice(values, "engine") === "ON",
    ...remarkOf(values),
  }),
  summary: (values, ctx) => [
    { label: "Waktu Mulai", value: ctx.step.startedAt ? clockTime(ctx.step.startedAt) : "–" },
    { label: "Waktu Stop", value: clockTime(ctx.now) },
    { label: "Temp.", value: `${decimal(parseDecimal(text(values, "temperature")) ?? 0, 1)} °C` },
    { label: "Quality", value: labelOf(QUALITY, choice(values, "quality")), tone: toneOf(QUALITY, choice(values, "quality")) },
    { label: "Rem Tangan", value: labelOf(ON_OFF, choice(values, "handbrake")) },
    { label: "Mesin", value: labelOf(ENGINE, choice(values, "engine")) },
    ...remarkSummary(values, "Keterangan"),
  ],
};

// --- segel ---

export const sealingForm: FormDefinition = {
  route: "sealing",
  title: "Segel",
  submitLabel: "Periksa dan kirim",
  initial: (ctx) => ({
    oldSeals: ctx.form.sealsInPlace.map((seal): OldSealRow => ({ tripSealId: seal.id, sealNo: seal.sealNo, opened: false, reason: "" })),
    seals: emptySlots(),
    photos: [],
    remark: "",
  }),
  fields: (_values, ctx) => [
    ...(ctx.form.sealsInPlace.length > 0
      ? [{ kind: "oldSeals" as const, key: "oldSeals", label: "Segel lama di truk. Tandai dibuka sebelum segel baru dipasang." }]
      : []),
    { kind: "stockSeals", key: "seals", label: "No Segel" },
    { kind: "photos", key: "photos", label: "Foto (tidak wajib)", max: 3 },
    remarkField("Keterangan", "Catatan locis (tidak wajib)"),
  ],
  validate: (values) => {
    const errors: Errors = {};
    const old = listOf<OldSealRow>(values, "oldSeals");
    if (old.some((seal) => !seal.opened)) errors.oldSeals = "Tandai semua segel lama sebagai dibuka.";
    else if (old.some((seal) => seal.reason.trim().length < 3)) errors.oldSeals = "Tulis alasan segel lama dibuka, minimal 3 huruf.";
    validateStockSeals(values, "seals", errors);
    return errors;
  },
  body: (values, _ctx, clientUuid): Omit<SealingBody, "photoFileIds"> & Record<string, unknown> => ({
    clientUuid,
    seals: pickedSeals(values, "seals").map((seal) => ({ sealId: seal.id })),
    removed: listOf<OldSealRow>(values, "oldSeals").map((seal) => ({ tripSealId: seal.tripSealId, reason: seal.reason.trim() })),
    ...remarkOf(values),
  }),
  summary: (values) => [
    ...listOf<OldSealRow>(values, "oldSeals").map((seal) => ({ label: `Dibuka: ${seal.sealNo}`, value: seal.reason.trim(), tone: "warn" as const })),
    ...sealSummary(values, "seals"),
    photoSummary(values),
    ...remarkSummary(values, "Keterangan"),
  ],
  photos: (values) => listOf<Photo>(values, "photos"),
};
