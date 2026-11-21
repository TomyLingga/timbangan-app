// What a decision screen shows and sends, per request type (apps/api/src/exceptions/decide.ts, docs Fase 1
// section 4.9): the answers offered, when a reason is required, the request body, and the figure rows.

import type { DecideBody, DecisionCode, ExceptionView } from "../api/types";
import { kg, pct, signedKg } from "../lib/format";
import { DISPOSITION, RECEIVING_REASONS } from "../forms/incoming";
import type { SummaryRow, Tone } from "../forms/shared";

export interface DecisionChoice {
  code: DecisionCode;
  label: string;
  tone: Tone;
}

const TYPE_LABELS: Record<string, string> = {
  PLATE: "Plat beda",
  GROSS_IN: "Selisih bruto",
  TARE_OUT: "Selisih tarra",
  NET_IN: "Selisih netto",
  NET_OUT: "Cek netto keluar",
  QC_HOLD: "QC ditahan",
};
export const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;

/** The three weight differences need a written reason (DIFFERENCE_TYPES in decide.ts). */
const REASON_TYPES = ["GROSS_IN", "TARE_OUT", "NET_IN"];
export const reasonRequired = (type: string) => REASON_TYPES.includes(type);

export function decisionChoices(type: string): DecisionChoice[] {
  if (type === "NET_OUT") {
    return [
      { code: "OK", label: "Sesuai", tone: "ok" },
      { code: "ADD_LOAD", label: "Tambah muatan", tone: "warn" },
      { code: "REDUCE_LOAD", label: "Kurangi muatan", tone: "warn" },
    ];
  }
  return [
    { code: "APPROVE", label: "Setujui", tone: "ok" },
    { code: "REJECT", label: "Tolak", tone: "bad" },
  ];
}

export interface DecisionInput {
  decision: DecisionCode | null;
  reason: string;
  updateMasterTare: boolean;
}

export const REASON_MAX = 300;

export function validateDecision(type: string, input: DecisionInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.decision || !decisionChoices(type).some((choice) => choice.code === input.decision)) errors.decision = "Pilih salah satu keputusan.";
  if (reasonRequired(type) && input.reason.trim().length < 3) errors.reason = "Alasan wajib diisi, minimal 3 huruf.";
  if (input.reason.trim().length > REASON_MAX) errors.reason = `Alasan paling panjang ${REASON_MAX} huruf.`;
  if (input.updateMasterTare && !(type === "TARE_OUT" && input.decision === "APPROVE")) {
    errors.updateMasterTare = "Tarra master hanya bisa diganti saat selisih tarra disetujui.";
  }
  return errors;
}

export function decisionBody(type: string, input: DecisionInput): DecideBody {
  const reason = input.reason.trim();
  return {
    decision: input.decision as DecisionCode,
    ...(reason ? { reason } : {}),
    ...(type === "TARE_OUT" && input.decision === "APPROVE" && input.updateMasterTare ? { updateMasterTare: true } : {}),
  };
}

const FIGURE_LABELS: Record<string, [string, string]> = {
  GROSS_IN: ["Bruto surat", "Bruto timbang"],
  NET_IN: ["Netto surat", "Netto timbang"],
  TARE_OUT: ["Tarra master", "Tarra timbang"],
  NET_OUT: ["Netto DO", "Netto timbang"],
};

/** Letter figure, scale figure, difference (kg and %), tolerance and the live weight. */
export function figureRows(view: ExceptionView): SummaryRow[] {
  const labels = FIGURE_LABELS[view.type];
  const rows: SummaryRow[] = [];
  if (labels) {
    rows.push({ label: labels[0], value: view.expectedValue === null ? "Belum ada" : kg(view.expectedValue) });
    rows.push({ label: labels[1], value: kg(view.actualValue) });
    if (view.diffValue !== null) {
      const beyond = view.diffPct !== null && view.tolerancePct !== null && Math.abs(view.diffPct) > view.tolerancePct;
      rows.push({ label: "Selisih", value: `${signedKg(view.diffValue)} · ${pct(view.diffPct === null ? null : Math.abs(view.diffPct))}`, ...(beyond ? { tone: "bad" as const } : {}) });
    }
    if (view.tolerancePct !== null) rows.push({ label: "Toleransi", value: pct(view.tolerancePct) });
  }
  if (view.liveWeightKg !== null) rows.push({ label: "Berat sekarang", value: kg(view.liveWeightKg) });
  return rows;
}

const letters = (plate: string | null) => (plate ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export function plateRows(view: ExceptionView): SummaryRow[] {
  const registered = view.trip.plateDisplay ?? view.plateNo ?? view.trip.plateNo ?? "–";
  const read = view.plateRead;
  return [
    read
      ? { label: "Plat kamera", value: read, ...(letters(read) !== letters(view.plateNo ?? view.trip.plateNo) ? { tone: "bad" as const } : { tone: "ok" as const }) }
      : { label: "Plat kamera", value: "Tidak terbaca", tone: "warn" },
    { label: "Plat registrasi", value: registered },
  ];
}

const QC_LABELS: Record<string, string> = { FFA: "FFA", MOISTURE: "MOIST", IMPURITIES: "IMPURITIES" };

/** The figures the QC operator entered, from the request context (apps/api/src/work/incoming.ts). */
export function qcRows(view: ExceptionView): SummaryRow[] {
  const context = view.context as { values?: Record<string, number>; disposition?: string; reasonCode?: string | null; remark?: string | null };
  const rows: SummaryRow[] = Object.entries(context.values ?? {}).map(([code, value]) => ({
    label: QC_LABELS[code] ?? code,
    value: String(value).replace(".", ","),
  }));
  if (context.disposition) {
    const option = DISPOSITION.find((item) => item.value === context.disposition);
    rows.push({ label: "Disposisi", value: option?.label ?? context.disposition, tone: option?.tone ?? "plain" });
  }
  if (context.reasonCode) rows.push({ label: "Keterangan", value: RECEIVING_REASONS.find((item) => item.value === context.reasonCode)?.label ?? context.reasonCode });
  if (context.remark) rows.push({ label: "Catatan QC", value: context.remark });
  return rows;
}
