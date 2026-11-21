// The "Alur penimbangan" and "Verifikasi plat" panels, derived from the screen state. Pure.
import { comparePlates } from "./plate";
import type { ScreenState } from "./screen";

export type StepStatus = "todo" | "current" | "done" | "attention" | "failed";

export interface FlowStep {
  label: string;
  status: StepStatus;
}

const LABELS = ["Tempel kartu RFID", "Data truk ditemukan", "Mencocokkan plat dengan kamera", "Berat stabil, hitung mundur", "Simpan data"] as const;

/** Index of the step that is current (or stuck); the steps before it are done. */
function position(state: ScreenState): { at: number; status: StepStatus; plateStep?: StepStatus } {
  const plateMatches = comparePlates(state.manualPlate ?? state.cameraPlate, state.card?.expected.plateNo) === "MATCH";
  const plateIssue = state.exception?.type === "PLATE";
  switch (state.phase) {
    case "idle":
      return { at: 0, status: "current" };
    case "lookup":
      return { at: 1, status: "current" };
    case "truck":
    case "settling":
    case "countdown":
      return plateMatches ? { at: 3, status: "current" } : { at: 2, status: "current" };
    case "plateRetry":
      return { at: 2, status: "attention" };
    case "sending":
      return { at: 4, status: "current" };
    case "saved":
      return { at: 5, status: "done" };
    case "waiting":
      return plateIssue ? { at: 4, status: "todo", plateStep: "attention" } : { at: 4, status: "attention" };
    case "decided":
      if (state.outcome?.kind === "SAVED") return { at: 5, status: "done" };
      return plateIssue ? { at: 4, status: "todo", plateStep: "failed" } : { at: 4, status: "failed" };
    case "refused":
      return state.card ? { at: 4, status: "failed" } : { at: 1, status: "failed" };
  }
}

export function flowSteps(state: ScreenState): FlowStep[] {
  const { at, status, plateStep } = position(state);
  return LABELS.map((label, index) => {
    if (index === 2 && plateStep) return { label, status: plateStep };
    if (index < at) return { label, status: "done" };
    if (index === at) return { label, status };
    return { label, status: "todo" };
  });
}

export type PlateCheckStatus = "WAITING_CARD" | "CHECKING" | "SAME" | "DIFFERENT" | "WAITING_DECISION";

export interface PlateVerification {
  /** Weighing attempts sent for this card. */
  attempt: number;
  /** Known after the API answered "plate not right" once: attempts so far plus the attempts left. */
  maxAttempts: number | null;
  plate: string | null;
  status: PlateCheckStatus;
}

export function plateVerification(state: ScreenState): PlateVerification {
  const plate = state.manualPlate ?? state.cameraPlate;
  const maxAttempts = state.plateAttemptsLeft !== null ? state.plateTry + state.plateAttemptsLeft : null;
  // while the weight settles the next attempt is being prepared, so it already counts
  const preparing = state.phase === "truck" || state.phase === "settling" || state.phase === "countdown";
  const base = { attempt: state.plateTry + (preparing ? 1 : 0), maxAttempts, plate };
  if (!state.card) return { ...base, status: "WAITING_CARD" };
  if (state.phase === "waiting" && state.exception?.type === "PLATE") return { ...base, status: "WAITING_DECISION" };
  const comparison = comparePlates(plate, state.card.expected.plateNo);
  if (comparison === "NO_READ") return { ...base, status: "CHECKING" };
  return { ...base, status: comparison === "MATCH" ? "SAME" : "DIFFERENT" };
}
