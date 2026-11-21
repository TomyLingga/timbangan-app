import { describe, expect, it } from "vitest";
import type { FormData, FormParameter, WorkRow } from "../api/types";
import { qcReceivingForm, resealForm, sealCheckForm, unloadingForm } from "./incoming";
import { cleanlinessForm, loadingFinishForm, loadingStartForm, qcLoadingForm, sealingForm } from "./outgoing";
import { formFor } from "./registry";
import type { FormContext, FormValues } from "./shared";

const UUID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-21T07:30:00Z");

const param = (code: string, name: string, required: boolean, min = 0, max = 20, decimals = 2, spec: FormParameter["spec"] = null): FormParameter => ({
  code,
  name,
  unit: "%",
  decimals,
  minValid: min,
  maxValid: max,
  required,
  spec,
});

function context(stepCode: string, flowCode: string, form: Partial<FormData> = {}, step: Partial<WorkRow> = {}): FormContext {
  return {
    now: NOW,
    step: {
      id: 7,
      stepCode,
      name: stepCode,
      module: "qc",
      status: "READY",
      result: null,
      attempt: 1,
      readyAt: "2026-11-21T07:00:00Z",
      startedAt: null,
      truck: {
        tripId: 3,
        tripNo: "TR-0003",
        plateNo: "ZZ0001CTH",
        plateDisplay: "ZZ 0001 CTH",
        direction: flowCode.startsWith("IN") ? "IN" : "OUT",
        flowCode,
        product: { id: 1, name: "Produk Contoh" },
        partner: { id: 1, name: "Pemasok Contoh" },
        transporter: null,
        driverName: "Supir Contoh",
      },
      ...step,
    },
    form: { letter: null, declaredSeals: [], tanks: [{ id: 4, code: "T-01", name: "Tangki 1" }, { id: 5, code: "T-02", name: "Tangki 2" }], parameters: [], sealsInPlace: [], history: [], ...form },
  };
}

const fill = (base: FormValues, changes: FormValues): FormValues => ({ ...base, ...changes });

describe("seal check", () => {
  const ctx = context("SEAL_CHECK", "IN_CPO", { declaredSeals: [{ id: 1, sealNo: "SG-0001", kind: "LOCIS" }, { id: 2, sealNo: "SG-0002", kind: "LOCIS" }] });
  it("starts with the seals of the letter and asks for the state of each", () => {
    const values = sealCheckForm.initial(ctx);
    expect(sealCheckForm.validate(values, ctx)).toEqual({ seals: "Pilih Utuh atau Rusak untuk tiap segel.", result: "Pilih salah satu." });
  });
  it("needs a remark when the result is a failure, and builds the body", () => {
    const values = fill(sealCheckForm.initial(ctx), {
      seals: [
        { sealNo: "SG-0001", intact: true, declared: true },
        { sealNo: "sg-0002 ", intact: false, declared: true },
      ],
      result: "FAIL",
    });
    expect(sealCheckForm.validate(values, ctx)).toEqual({ remark: "Catatan wajib diisi bila hasilnya gagal." });
    const done = fill(values, { remark: " Segel 2 putus " });
    expect(sealCheckForm.validate(done, ctx)).toEqual({});
    expect(sealCheckForm.body(done, ctx, UUID)).toEqual({
      clientUuid: UUID,
      seals: [
        { sealNo: "SG-0001", intact: true },
        { sealNo: "SG-0002", intact: false },
      ],
      result: "FAIL",
      remark: "Segel 2 putus",
    });
  });
  it("refuses the same seal number twice", () => {
    const values = fill(sealCheckForm.initial(ctx), {
      seals: [
        { sealNo: "SG-1", intact: true, declared: false },
        { sealNo: "sg-1", intact: true, declared: false },
      ],
      result: "PASS",
    });
    expect(sealCheckForm.validate(values, ctx).seals).toBe("Ada nomor segel yang tertulis dua kali.");
  });
});

describe("QC pass CPO", () => {
  const parameters = [param("FFA", "FFA", true, 0, 20, 2, { min: null, max: 5 }), param("MOISTURE", "Moisture", true, 0, 5, 3), param("IMPURITIES", "Impurities", false, 0, 5, 3)];
  const ctx = context("QC", "IN_CPO", { parameters });
  it("checks figures against their range with the old labels", () => {
    const values = fill(qcReceivingForm.initial(ctx), { "value.FFA": "25", "value.MOISTURE": "abc", disposition: "OK" });
    expect(qcReceivingForm.validate(values, ctx)).toEqual({
      "value.FFA": "FFA harus antara 0 sampai 20.",
      "value.MOISTURE": "MOIST harus angka, misalnya 3,25.",
    });
  });
  it("refuses more decimals than the parameter has", () => {
    const values = fill(qcReceivingForm.initial(ctx), { "value.FFA": "3,123", "value.MOISTURE": "0,1", disposition: "OK" });
    expect(qcReceivingForm.validate(values, ctx)).toEqual({ "value.FFA": "FFA paling banyak 2 angka di belakang koma." });
  });
  it("asks for the out-spec reason unless the disposition is OK and shows the field only then", () => {
    const values = fill(qcReceivingForm.initial(ctx), { "value.FFA": "5,6", "value.MOISTURE": "0,15", disposition: "HOLD" });
    expect(qcReceivingForm.fields(values, ctx).some((field) => field.key === "reasonCode")).toBe(true);
    expect(qcReceivingForm.validate(values, ctx)).toEqual({ reasonCode: "Keterangan wajib dipilih bila disposisi bukan OK." });
    const done = fill(values, { reasonCode: "FFA_OUT", remark: "Sampel ulang" });
    expect(qcReceivingForm.body(done, ctx, UUID)).toEqual({
      clientUuid: UUID,
      values: { FFA: 5.6, MOISTURE: 0.15 },
      disposition: "HOLD",
      reasonCode: "FFA_OUT",
      remark: "Sampel ulang",
    });
    const rows = qcReceivingForm.summary(done, ctx);
    expect(rows.find((row) => row.label === "FFA")).toEqual({ label: "FFA", value: "5,60 % · di luar spek", tone: "warn" });
  });
  it("leaves the reason out of an OK body", () => {
    const values = fill(qcReceivingForm.initial(ctx), { "value.FFA": "3", "value.MOISTURE": "0,1", "value.IMPURITIES": "0,02", disposition: "OK", reasonCode: "FFA_OUT" });
    expect(qcReceivingForm.validate(values, ctx)).toEqual({});
    expect(qcReceivingForm.body(values, ctx, UUID)).toEqual({ clientUuid: UUID, values: { FFA: 3, MOISTURE: 0.1, IMPURITIES: 0.02 }, disposition: "OK" });
  });
});

describe("stock seals (reseal and sealing)", () => {
  const ctx = context("RESEAL", "IN_CPO");
  it("requires seal 1 and refuses the same seal twice", () => {
    expect(resealForm.validate(resealForm.initial(ctx), ctx)).toEqual({ seals: "No Segel 1 wajib dipilih." });
    const twice = fill(resealForm.initial(ctx), { seals: [{ id: 1, sealNo: "L-1" }, null, { id: 1, sealNo: "L-1" }, null] });
    expect(resealForm.validate(twice, ctx)).toEqual({ seals: "Segel yang sama dipilih dua kali." });
  });
  it("sends the chosen seals in slot order", () => {
    const values = fill(resealForm.initial(ctx), { seals: [{ id: 1, sealNo: "L-1" }, null, { id: 9, sealNo: "L-9" }, null], remark: "" });
    expect(resealForm.body(values, ctx, UUID)).toEqual({ clientUuid: UUID, seals: [{ sealId: 1 }, { sealId: 9 }] });
  });
  it("asks to mark old seals opened with a reason before new ones", () => {
    const sealing = context("SEALING", "OUT_BULK", {
      sealsInPlace: [{ id: 31, sealId: 5, sealNo: "L-0005", kind: "LOCIS", position: null, appliedAt: "2026-11-21T06:00:00Z" }],
    });
    const values = fill(sealingForm.initial(sealing), { seals: [{ id: 2, sealNo: "L-0002" }, null, null, null] });
    expect(sealingForm.validate(values, sealing)).toEqual({ oldSeals: "Tandai semua segel lama sebagai dibuka." });
    const opened = fill(values, { oldSeals: [{ tripSealId: 31, sealNo: "L-0005", opened: true, reason: "Tambah muatan" }] });
    expect(sealingForm.validate(opened, sealing)).toEqual({});
    expect(sealingForm.body(opened, sealing, UUID)).toEqual({
      clientUuid: UUID,
      seals: [{ sealId: 2 }],
      removed: [{ tripSealId: 31, reason: "Tambah muatan" }],
    });
  });
});

describe("unloading", () => {
  const ctx = context("UNLOADING", "IN_CPO");
  const complete: FormValues = {
    tankId: "4",
    doorNo: "3",
    wood: "TIDAK",
    wire: "ADA",
    plastic: "TIDAK",
    handbrake: "ON",
    engine: "OFF",
    manhole: "OPEN",
    valve: "ACTIVE",
    tankEmpty: true,
  };
  it("requires the tank-empty tick", () => {
    const values = fill(unloadingForm.initial(ctx), { ...complete, tankEmpty: false });
    expect(unloadingForm.validate(values, ctx)).toEqual({ tankEmpty: "Centang bila tangki truk sudah kosong. Bongkar baru bisa disimpan setelah itu." });
  });
  it("turns the two-choice answers into the booleans of the API", () => {
    const values = fill(unloadingForm.initial(ctx), complete);
    expect(unloadingForm.validate(values, ctx)).toEqual({});
    expect(unloadingForm.body(values, ctx, UUID)).toEqual({
      clientUuid: UUID,
      tankId: 4,
      doorNo: 3,
      wood: false,
      wire: true,
      plastic: false,
      handbrakeOn: true,
      engineOn: false,
      manholeOpen: true,
      dischargeValveActive: true,
      tankEmpty: true,
    });
  });
  it("hands the photos to the queue", () => {
    const photos = [{ uri: "file:///p1.jpg", width: 1600, height: 1200 }];
    expect(unloadingForm.photos?.(fill(unloadingForm.initial(ctx), { photos }))).toEqual(photos);
  });
});

describe("cleanliness", () => {
  const items = { containerClean: "OK", noLiquid: "OK", noForeignObject: "OK", noPestOrNajis: "OK", wallsCleanDryNoLeak: "NOT_OK", noOdor: "OK" };
  it("requires the nozzle items for bulk loading only", () => {
    const bulk = context("CLEANLINESS", "OUT_BULK");
    const packed = context("CLEANLINESS", "OUT_PACKED");
    const values = fill(cleanlinessForm.initial(bulk), { ...items, disposition: "NOT_OK" });
    expect(Object.keys(cleanlinessForm.validate(values, bulk)).sort()).toEqual(["flashLight", "nozzleNo", "nozzleOdor", "nozzleVisual"]);
    expect(cleanlinessForm.validate(values, packed)).toEqual({});
    expect(cleanlinessForm.body(values, packed, UUID)).toEqual({
      clientUuid: UUID,
      items: { containerClean: true, noLiquid: true, noForeignObject: true, noPestOrNajis: true, wallsCleanDryNoLeak: false, noOdor: true },
      disposition: "NOT_OK",
    });
  });
  it("keeps every item and the nozzle answers in the body", () => {
    const bulk = context("CLEANLINESS", "OUT_BULK");
    const values = fill(cleanlinessForm.initial(bulk), { ...items, wallsCleanDryNoLeak: "OK", flashLight: "OK", nozzleVisual: "OK", nozzleNo: "2", nozzleOdor: "NOT_OK", disposition: "OK" });
    expect(cleanlinessForm.validate(values, bulk)).toEqual({});
    const body = cleanlinessForm.body(values, bulk, UUID);
    expect(body.items).toMatchObject({ flashLight: true, nozzleVisual: true, nozzleOdor: false });
    expect(body).toMatchObject({ nozzleNo: 2, disposition: "OK" });
  });
});

describe("QC loading", () => {
  const parameters = [param("FFA", "FFA", true), param("MNI", "M dan I", true, 0, 5, 3), param("IV", "IV", false, 0, 200)];
  const ctx = context("QC_LOADING", "OUT_BULK", { parameters });
  it("needs the tank, and a different blend tank when blending", () => {
    const values = fill(qcLoadingForm.initial(ctx), { "value.FFA": "0,05", "value.MNI": "0,1", tankId: "4", blend: "YES", blendTankId: "4" });
    expect(qcLoadingForm.validate(values, ctx)).toEqual({ blendTankId: "Tangki blend harus berbeda dari tangki utama." });
    const done = fill(values, { blendTankId: "5", "value.IV": "52,4" });
    expect(qcLoadingForm.validate(done, ctx)).toEqual({});
    expect(qcLoadingForm.body(done, ctx, UUID)).toEqual({ clientUuid: UUID, values: { FFA: 0.05, MNI: 0.1, IV: 52.4 }, tankId: 4, blendTankId: 5 });
  });
  it("uses the old labels for the required figures", () => {
    const errors = qcLoadingForm.validate(qcLoadingForm.initial(ctx), ctx);
    expect(errors["value.FFA"]).toBe("Free Fatty Acid wajib diisi.");
    expect(errors["value.MNI"]).toBe("M dan I wajib diisi.");
    expect(errors.tankId).toBe("Tangki wajib dipilih.");
  });
});

describe("loading", () => {
  it("starts with the phone time, then stops with the figures", () => {
    const ready = context("LOADING", "OUT_BULK");
    expect(formFor(ready.step)).toBe(loadingStartForm);
    expect(loadingStartForm.body({}, ready, UUID)).toEqual({ clientUuid: UUID, startedAt: NOW.toISOString() });

    const running = context("LOADING", "OUT_BULK", {}, { status: "IN_PROGRESS", startedAt: "2026-11-21T07:05:00Z" });
    expect(formFor(running.step)).toBe(loadingFinishForm);
    const values = fill(loadingFinishForm.initial(running), { temperature: "160", quality: "OK", handbrake: "ON", engine: "OFF" });
    expect(loadingFinishForm.validate(values, running)).toEqual({ temperature: "Temp. harus antara 0 sampai 150." });
    const done = fill(values, { temperature: "45,5" });
    expect(loadingFinishForm.body(done, running, UUID)).toEqual({
      clientUuid: UUID,
      finishedAt: NOW.toISOString(),
      temperatureC: 45.5,
      qualityOk: true,
      handbrakeOn: true,
      engineOff: true,
    });
    expect(loadingFinishForm.summary(done, running).slice(0, 2)).toEqual([
      { label: "Waktu Mulai", value: "14.05" },
      { label: "Waktu Stop", value: "14.30" },
    ]);
  });
});

describe("formFor", () => {
  it("has no form for a QC hold or for incoming goods", () => {
    expect(formFor(context("QC", "IN_CPO", {}, { status: "IN_PROGRESS", result: "HOLD" }).step)).toBeNull();
    expect(formFor(context("QC", "IN_GOODS").step)).toBeNull();
    expect(formFor(context("WEIGH_1", "IN_CPO").step)).toBeNull();
    expect(formFor(context("SEAL_CHECK", "IN_CPO").step)).toBe(sealCheckForm);
  });
});
