import { describe, expect, it } from "vitest";
import type { ExceptionView } from "../api/types";
import { decisionBody, decisionChoices, figureRows, plateRows, qcRows, reasonRequired, typeLabel, validateDecision } from "./decision";

const view = (changes: Partial<ExceptionView>): ExceptionView => ({
  id: 1,
  type: "GROSS_IN",
  status: "PENDING",
  decision: null,
  trip: { id: 3, tripNo: "TR-0003", plateNo: "ZZ0001CTH", plateDisplay: "ZZ 0001 CTH" },
  station: { id: 1, code: "WB-1", name: "Timbangan 1" },
  stage: 1,
  expectedValue: 41000,
  actualValue: 41500,
  diffValue: 500,
  diffPct: 1.2195,
  tolerancePct: 0.3,
  liveWeightKg: 41500,
  liveWeightAt: "2026-11-21T07:00:00Z",
  plateRead: "ZZ0001CTH",
  plateNo: "ZZ0001CTH",
  approverModule: "approvals",
  raisedAt: "2026-11-21T06:59:00Z",
  decidedAt: null,
  decidedBy: null,
  reason: null,
  reportNo: null,
  weighingId: null,
  context: {},
  ...changes,
});

describe("choices per type", () => {
  it("offers approve and reject, and the three answers of the outgoing net check", () => {
    expect(decisionChoices("GROSS_IN").map((choice) => choice.label)).toEqual(["Setujui", "Tolak"]);
    expect(decisionChoices("NET_OUT").map((choice) => choice.code)).toEqual(["OK", "ADD_LOAD", "REDUCE_LOAD"]);
    expect(decisionChoices("NET_OUT").map((choice) => choice.label)).toEqual(["Sesuai", "Tambah muatan", "Kurangi muatan"]);
    expect(typeLabel("TARE_OUT")).toBe("Selisih tarra");
  });
  it("requires a reason for the three weight differences only", () => {
    expect(reasonRequired("GROSS_IN")).toBe(true);
    expect(reasonRequired("TARE_OUT")).toBe(true);
    expect(reasonRequired("NET_IN")).toBe(true);
    expect(reasonRequired("PLATE")).toBe(false);
    expect(reasonRequired("NET_OUT")).toBe(false);
    expect(reasonRequired("QC_HOLD")).toBe(false);
  });
});

describe("validateDecision and body", () => {
  it("asks for a reason of at least 3 letters", () => {
    expect(validateDecision("GROSS_IN", { decision: "APPROVE", reason: " ok ", updateMasterTare: false })).toEqual({ reason: "Alasan wajib diisi, minimal 3 huruf." });
    expect(validateDecision("PLATE", { decision: "APPROVE", reason: "", updateMasterTare: false })).toEqual({});
  });
  it("offers the master tare only on an approved tare difference", () => {
    expect(validateDecision("TARE_OUT", { decision: "REJECT", reason: "Truk tidak sesuai", updateMasterTare: true })).toEqual({
      updateMasterTare: "Tarra master hanya bisa diganti saat selisih tarra disetujui.",
    });
    expect(decisionBody("TARE_OUT", { decision: "APPROVE", reason: " Ganti ban ", updateMasterTare: true })).toEqual({
      decision: "APPROVE",
      reason: "Ganti ban",
      updateMasterTare: true,
    });
    expect(decisionBody("NET_OUT", { decision: "ADD_LOAD", reason: "", updateMasterTare: false })).toEqual({ decision: "ADD_LOAD" });
  });
  it("refuses a decision code that does not belong to the type", () => {
    expect(validateDecision("NET_OUT", { decision: "APPROVE", reason: "", updateMasterTare: false })).toEqual({ decision: "Pilih salah satu keputusan." });
  });
});

describe("figures", () => {
  it("shows letter, scale, difference in kg and percent, and tolerance, marking a difference beyond tolerance", () => {
    expect(figureRows(view({}))).toEqual([
      { label: "Bruto surat", value: "41.000 kg" },
      { label: "Bruto timbang", value: "41.500 kg" },
      { label: "Selisih", value: "+500 kg · 1,22%", tone: "bad" },
      { label: "Toleransi", value: "0,30%" },
      { label: "Berat sekarang", value: "41.500 kg" },
    ]);
  });
  it("names the tare master and says when there is none", () => {
    const rows = figureRows(view({ type: "TARE_OUT", expectedValue: null, diffValue: null, diffPct: null }));
    expect(rows[0]).toEqual({ label: "Tarra master", value: "Belum ada" });
  });
  it("compares the camera plate with the registered plate", () => {
    expect(plateRows(view({ plateRead: "ZZ0007CTH" }))).toEqual([
      { label: "Plat kamera", value: "ZZ0007CTH", tone: "bad" },
      { label: "Plat registrasi", value: "ZZ 0001 CTH" },
    ]);
    expect(plateRows(view({ plateRead: null }))[0]).toEqual({ label: "Plat kamera", value: "Tidak terbaca", tone: "warn" });
  });
  it("shows the QC figures of a hold", () => {
    const rows = qcRows(view({ type: "QC_HOLD", context: { values: { FFA: 5.6, MOISTURE: 0.2 }, disposition: "HOLD", reasonCode: "FFA_OUT", remark: "Sampel keruh" } }));
    expect(rows).toEqual([
      { label: "FFA", value: "5,6" },
      { label: "MOIST", value: "0,2" },
      { label: "Disposisi", value: "HOLD", tone: "warn" },
      { label: "Keterangan", value: "FFA Out Spec" },
      { label: "Catatan QC", value: "Sampel keruh" },
    ]);
  });
});
