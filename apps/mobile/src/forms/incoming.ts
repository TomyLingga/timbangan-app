// The incoming CPO forms: seal check, QC pass, reseal of a rejected truck, unloading with the tank-empty tick.
// Fields and labels from docs/fase-5-rancangan.md sections 2 and 3; bodies as apps/api/src/work/incoming.ts takes them.

import type { QcReceivingBody, ResealBody, SealCheckBody, UnloadingBody } from "../api/types";
import {
  ADA_TIDAK,
  choice,
  emptySlots,
  type Errors,
  flag,
  type FormDefinition,
  labelOf,
  listOf,
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
  type SealCheckRow,
  sealSummary,
  tankText,
  text,
  toneOf,
  validateParameters,
  validateStockSeals,
  validateTank,
} from "./shared";

// --- cek segel ---

export const SEAL_STATE = [
  { value: "INTACT", label: "Utuh", tone: "ok" as const },
  { value: "BROKEN", label: "Rusak", tone: "bad" as const },
];
export const SEAL_RESULT = [
  { value: "PASS", label: "Lulus", tone: "ok" as const },
  { value: "FAIL", label: "Gagal", tone: "bad" as const },
];

export const sealCheckForm: FormDefinition = {
  route: "seal-check",
  title: "Cek segel",
  submitLabel: "Periksa dan kirim",
  initial: (ctx) => ({
    seals: ctx.form.declaredSeals.map((seal): SealCheckRow => ({ sealNo: seal.sealNo, intact: null, declared: true })),
    result: null,
    remark: "",
    photos: [],
  }),
  fields: () => [
    { kind: "sealCheck", key: "seals", label: "Segel di surat" },
    { kind: "choice", key: "result", label: "Hasil", options: SEAL_RESULT, required: true },
    remarkField("Catatan", "Wajib bila hasilnya gagal"),
    { kind: "photos", key: "photos", label: "Foto (tidak wajib)", max: 3 },
  ],
  validate: (values) => {
    const errors: Errors = {};
    const seals = listOf<SealCheckRow>(values, "seals");
    if (seals.length === 0) errors.seals = "Isi paling sedikit satu segel.";
    else if (seals.some((seal) => seal.sealNo.trim() === "")) errors.seals = "Nomor segel wajib diisi.";
    else if (seals.some((seal) => seal.intact === null)) errors.seals = "Pilih Utuh atau Rusak untuk tiap segel.";
    else {
      const numbers = seals.map((seal) => seal.sealNo.trim().toUpperCase());
      if (new Set(numbers).size !== numbers.length) errors.seals = "Ada nomor segel yang tertulis dua kali.";
    }
    requireChoices(values, ["result"], errors);
    if (choice(values, "result") === "FAIL" && !text(values, "remark").trim()) errors.remark = "Catatan wajib diisi bila hasilnya gagal.";
    return errors;
  },
  body: (values, _ctx, clientUuid): Omit<SealCheckBody, "photoFileIds"> & Record<string, unknown> => ({
    clientUuid,
    seals: listOf<SealCheckRow>(values, "seals").map((seal) => ({ sealNo: seal.sealNo.trim().toUpperCase(), intact: seal.intact === true })),
    result: choice(values, "result") === "FAIL" ? "FAIL" : "PASS",
    ...remarkOf(values),
  }),
  summary: (values) => [
    ...listOf<SealCheckRow>(values, "seals").map((seal) => ({
      label: `Segel ${seal.sealNo}`,
      value: seal.intact ? "Utuh" : "Rusak",
      tone: seal.intact ? ("ok" as const) : ("bad" as const),
    })),
    { label: "Hasil", value: labelOf(SEAL_RESULT, choice(values, "result")), tone: toneOf(SEAL_RESULT, choice(values, "result")) },
    ...remarkSummary(values, "Catatan"),
    photoSummary(values),
  ],
  photos: (values) => listOf<Photo>(values, "photos"),
};

// --- QC pass CPO ---

export const DISPOSITION = [
  { value: "OK", label: "OK", tone: "ok" as const },
  { value: "HOLD", label: "HOLD", tone: "warn" as const },
  { value: "NOT_OK", label: "NOT OK", tone: "bad" as const },
];
export const RECEIVING_REASONS = [
  { value: "FFA_OUT", label: "FFA Out Spec" },
  { value: "MI_OUT", label: "M & I Out Spec" },
  { value: "FFA_MI_OUT", label: "FFA Out Spec & M & I Out Spec" },
];

export const qcReceivingForm: FormDefinition = {
  route: "qc-receiving",
  title: "QC pass CPO",
  submitLabel: "Periksa dan kirim",
  initial: (ctx) => ({
    ...Object.fromEntries(ctx.form.parameters.map((parameter) => [`value.${parameter.code}`, ""])),
    disposition: null,
    reasonCode: null,
    remark: "",
  }),
  fields: (values, ctx) => [
    { kind: "section", key: "s-values", title: "Hasil analisa" },
    ...parameterFields(ctx.form.parameters),
    { kind: "choice", key: "disposition", label: "Disposisi", options: DISPOSITION, required: true },
    ...(choice(values, "disposition") && choice(values, "disposition") !== "OK"
      ? [{ kind: "choice" as const, key: "reasonCode", label: "Keterangan", options: RECEIVING_REASONS, required: true, columns: 1 }]
      : []),
    remarkField("Catatan", "Catatan QC (tidak wajib)"),
  ],
  validate: (values, ctx) => {
    const errors: Errors = {};
    validateParameters(values, ctx.form.parameters, errors);
    requireChoices(values, ["disposition"], errors);
    const disposition = choice(values, "disposition");
    if (disposition && disposition !== "OK" && !choice(values, "reasonCode")) errors.reasonCode = "Keterangan wajib dipilih bila disposisi bukan OK.";
    return errors;
  },
  body: (values, ctx, clientUuid): QcReceivingBody & Record<string, unknown> => {
    const disposition = (choice(values, "disposition") ?? "OK") as QcReceivingBody["disposition"];
    return {
      clientUuid,
      // only the parameters the API sent: it refuses any other code
      values: parameterValues(values, ctx.form.parameters),
      disposition,
      ...(disposition !== "OK" ? { reasonCode: choice(values, "reasonCode") as QcReceivingBody["reasonCode"] } : {}),
      ...remarkOf(values),
    };
  },
  summary: (values, ctx) => {
    const disposition = choice(values, "disposition");
    return [
      ...parameterSummary(values, ctx.form.parameters),
      { label: "Disposisi", value: labelOf(DISPOSITION, disposition), tone: toneOf(DISPOSITION, disposition) },
      ...(disposition && disposition !== "OK" ? [{ label: "Keterangan", value: labelOf(RECEIVING_REASONS, choice(values, "reasonCode")) }] : []),
      ...(disposition && disposition !== "OK" ? [{ label: "Akibat", value: "Truk ditahan sampai keputusan QC", tone: "warn" as const }] : []),
      ...remarkSummary(values, "Catatan"),
    ];
  },
};

// --- segel kembali ---

export const resealForm: FormDefinition = {
  route: "reseal",
  title: "Segel kembali",
  submitLabel: "Periksa dan kirim",
  initial: () => ({ seals: emptySlots(), remark: "" }),
  fields: () => [
    { kind: "stockSeals", key: "seals", label: "No Segel" },
    remarkField("Keterangan", "Keterangan (tidak wajib)"),
  ],
  validate: (values) => {
    const errors: Errors = {};
    validateStockSeals(values, "seals", errors);
    return errors;
  },
  body: (values, _ctx, clientUuid): ResealBody & Record<string, unknown> => ({
    clientUuid,
    seals: pickedSeals(values, "seals").map((seal) => ({ sealId: seal.id })),
    ...remarkOf(values),
  }),
  summary: (values) => [...sealSummary(values, "seals"), ...remarkSummary(values, "Keterangan")],
};

// --- bongkar ---

export const MAINHOLE = [
  { value: "OPEN", label: "Terbuka" },
  { value: "CLOSED", label: "Tertutup" },
];
export const VALVE = [
  { value: "ACTIVE", label: "Aktif" },
  { value: "INACTIVE", label: "Tidak Aktif" },
];
export const DOORS = Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));

const UNLOADING_CHOICES: [string, string, typeof ON_OFF][] = [
  ["wood", "Kayu", ADA_TIDAK],
  ["wire", "Kawat", ADA_TIDAK],
  ["plastic", "Plastik", ADA_TIDAK],
  ["handbrake", "Rem Tangan", ON_OFF],
  ["engine", "Mesin", ON_OFF],
  ["manhole", "Mainhole", MAINHOLE],
  ["valve", "Discharge Valve", VALVE],
];

export const unloadingForm: FormDefinition = {
  route: "unloading",
  title: "Bongkar",
  submitLabel: "Periksa dan kirim",
  initial: () => ({
    tankId: null,
    doorNo: null,
    ...Object.fromEntries(UNLOADING_CHOICES.map(([key]) => [key, null])),
    tankEmpty: false,
    photos: [],
    remark: "",
  }),
  fields: () => [
    { kind: "tank", key: "tankId", label: "Pilih Tanki", required: true },
    { kind: "choice", key: "doorNo", label: "No Pintu", options: DOORS, required: true, columns: 5 },
    ...UNLOADING_CHOICES.map(([key, label, options]) => ({ kind: "choice" as const, key, label, options, required: true })),
    { kind: "tick", key: "tankEmpty", label: "Tangki truk kosong", required: true },
    { kind: "photos", key: "photos", label: "Foto (paling banyak 3)", max: 3 },
    remarkField("Keterangan", "Keterangan (tidak wajib)"),
  ],
  validate: (values, ctx) => {
    const errors: Errors = {};
    validateTank(values, "tankId", ctx.form.tanks, "Tangki wajib dipilih.", errors);
    requireChoices(values, ["doorNo", ...UNLOADING_CHOICES.map(([key]) => key)], errors);
    if (!flag(values, "tankEmpty")) errors.tankEmpty = "Centang bila tangki truk sudah kosong. Bongkar baru bisa disimpan setelah itu.";
    if (listOf<Photo>(values, "photos").length > 3) errors.photos = "Paling banyak 3 foto.";
    return errors;
  },
  body: (values, _ctx, clientUuid): Omit<UnloadingBody, "photoFileIds"> & Record<string, unknown> => ({
    clientUuid,
    tankId: Number(choice(values, "tankId")),
    doorNo: Number(choice(values, "doorNo")),
    wood: choice(values, "wood") === "ADA",
    wire: choice(values, "wire") === "ADA",
    plastic: choice(values, "plastic") === "ADA",
    handbrakeOn: choice(values, "handbrake") === "ON",
    engineOn: choice(values, "engine") === "ON",
    manholeOpen: choice(values, "manhole") === "OPEN",
    dischargeValveActive: choice(values, "valve") === "ACTIVE",
    tankEmpty: true,
    ...remarkOf(values),
  }),
  summary: (values, ctx) => [
    { label: "Tanki", value: tankText(ctx.form.tanks, choice(values, "tankId")) },
    { label: "No Pintu", value: choice(values, "doorNo") ?? "–" },
    ...UNLOADING_CHOICES.map(([key, label, options]) => ({ label, value: labelOf(options, choice(values, key)), tone: toneOf(options, choice(values, key)) })),
    { label: "Tangki truk kosong", value: flag(values, "tankEmpty") ? "Ya" : "Belum", tone: flag(values, "tankEmpty") ? ("ok" as const) : ("bad" as const) },
    photoSummary(values),
    ...remarkSummary(values, "Keterangan"),
  ],
  photos: (values) => listOf<Photo>(values, "photos"),
};
