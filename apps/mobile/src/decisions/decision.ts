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

/** What became of a decided request; a refused one says whether the truck backed off or was turned away. */
export function statusText(view: Pick<ExceptionView, "type" | "status" | "decision">): string {
  if (view.status === "REJECTED" && view.type !== "QC_HOLD") return view.decision === "REJECT" ? "Truk ditolak" : "Mundur/hold";
  return STATUS_TEXT[view.status] ?? view.status;
}

/** The hint under the reason field before a decision is tapped. */
export function reasonHint(view: Pick<ExceptionView, "type" | "stage" | "options">): string {
  if (reasonRequired(view.type)) return "Wajib, minimal 3 huruf";
  return decisionChoices(view).some((choice) => choice.code === "REJECT") && view.type !== "QC_HOLD" ? "Wajib bila truk ditolak" : "Tidak wajib";
}

/** What became of a request that no longer waits. */
export const STATUS_TEXT: Record<string, string> = {
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  RETRY: "Diminta muat ulang",
  CANCELLED: "Batal (truk turun dari timbangan)",
  EXPIRED: "Kedaluwarsa",
};

/** The three weight differences need a written reason, and so does turning a truck away (decide.ts). */
const REASON_TYPES = ["GROSS_IN", "TARE_OUT", "NET_IN"];
export const reasonRequired = (type: string, decision: DecisionCode | null = null) =>
  REASON_TYPES.includes(type) || (decision === "REJECT" && type !== "QC_HOLD");

const CHOICE: Record<DecisionCode, DecisionChoice> = {
  APPROVE: { code: "APPROVE", label: "Setujui", tone: "ok" },
  HOLD: { code: "HOLD", label: "Mundur/hold", tone: "warn" },
  REJECT: { code: "REJECT", label: "Tolak truk", tone: "bad" },
  OK: { code: "OK", label: "Sesuai", tone: "ok" },
  ADD_LOAD: { code: "ADD_LOAD", label: "Isi lagi", tone: "warn" },
  REDUCE_LOAD: { code: "REDUCE_LOAD", label: "Kurangi isi", tone: "warn" },
};

/** What the request offers when the server did not say (an older API): the same rules as allowedDecisions. */
function fallbackOptions(type: string, stage: number | null): DecisionCode[] {
  if (type === "NET_OUT") return ["OK", "ADD_LOAD", "REDUCE_LOAD"];
  if (type === "QC_HOLD") return ["APPROVE", "REJECT"];
  if (type === "NET_IN" || stage === 2) return ["APPROVE", "HOLD"];
  return ["APPROVE", "HOLD", "REJECT"];
}

export function decisionChoices(view: Pick<ExceptionView, "type" | "stage" | "options">): DecisionChoice[] {
  const codes = view.options && view.options.length > 0 ? view.options : fallbackOptions(view.type, view.stage);
  return codes.map((code) => {
    const choice = CHOICE[code] ?? { code, label: code, tone: "warn" as Tone };
    // a QC hold that is refused is a spec reject, not a truck turned away at the weighbridge
    return view.type === "QC_HOLD" && code === "REJECT" ? { ...choice, label: "Tolak" } : choice;
  });
}

export interface DecisionInput {
  decision: DecisionCode | null;
  reason: string;
  updateMasterTare: boolean;
}

export const REASON_MAX = 300;

export function validateDecision(view: Pick<ExceptionView, "type" | "stage" | "options">, input: DecisionInput): Record<string, string> {
  const type = view.type;
  const errors: Record<string, string> = {};
  if (!input.decision || !decisionChoices(view).some((choice) => choice.code === input.decision)) errors.decision = "Pilih salah satu keputusan.";
  if (reasonRequired(type, input.decision) && input.reason.trim().length < 3) errors.reason = "Alasan wajib diisi, minimal 3 huruf.";
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
