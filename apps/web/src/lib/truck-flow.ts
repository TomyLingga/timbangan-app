// The flow of trucks through the plant, stage by stage, from GET /api/trips/flow:
// the trucks expected today, the trucks inside grouped by their current step,
// and the trucks that finished today, each split into incoming and outgoing.
// Nothing here is estimated: a stage shows exactly what the answer holds.

import type { Direction } from "@/lib/types";

export type StageKey = "upcoming" | "gate" | "weigh1" | "qc" | "bay" | "seal" | "weigh2" | "exit";

export interface Stage {
  key: StageKey;
  label: string;
}

/** The stages in the order a truck passes them. */
export const STAGES: readonly Stage[] = [
  { key: "upcoming", label: "Akan datang" },
  { key: "gate", label: "Pos dan cek segel" },
  { key: "weigh1", label: "Timbang 1" },
  { key: "qc", label: "QC dan pemeriksaan" },
  { key: "bay", label: "Bongkar atau muat" },
  { key: "seal", label: "Segel" },
  { key: "weigh2", label: "Timbang 2" },
  { key: "exit", label: "Keluar" },
];

/**
 * The steps of the plant and the stage each one belongs to.
 *   incoming: CHECK_IN, SEAL_CHECK, WEIGH_1, QC, UNLOADING, TANK_CHECK, RESEAL, WEIGH_2, CHECK_OUT
 *   outgoing: CHECK_IN, WEIGH_1, CLEANLINESS, QC_LOADING, LOADING, SEALING, WEIGH_2, CHECK_OUT
 * The seal check of an incoming truck happens right after the gate, before the
 * first weighing, so it belongs to the gate stage.
 */
const STEP_STAGE: Readonly<Record<string, StageKey>> = {
  CHECK_IN: "gate",
  SEAL_CHECK: "gate",
  WEIGH_1: "weigh1",
  QC: "qc",
  CLEANLINESS: "qc",
  QC_LOADING: "qc",
  UNLOADING: "bay",
  TANK_CHECK: "bay",
  LOADING: "bay",
  RESEAL: "seal",
  SEALING: "seal",
  WEIGH_2: "weigh2",
  CHECK_OUT: "exit",
};

/** The stage of a truck inside the plant. No step yet means just through the gate; an unknown step gives null. */
export function stageOfStep(step: string | null): StageKey | null {
  if (step === null) return "gate";
  return STEP_STAGE[step.toUpperCase()] ?? null;
}

/** The answer of GET /api/trips/flow. */
export interface FlowAnswer {
  date: string;
  upcoming: { in: number; out: number };
  inside: ReadonlyArray<{ stepCode: string | null; in: number; out: number }>;
  finishedToday: { in: number; out: number };
}

export interface StageCount {
  key: StageKey;
  label: string;
  incoming: number;
  outgoing: number;
  total: number;
}

export interface FlowCounts {
  stages: StageCount[];
  /** Trucks inside whose step is not one of the plant's steps. */
  unplaced: number;
  /** Index of the stage with the most trucks, or null when every stage is empty. Ties go to the earlier stage. */
  peak: number | null;
}

function findPeak(stages: readonly StageCount[]): number | null {
  let peak: number | null = null;
  stages.forEach((stage, index) => {
    if (stage.total > 0 && (peak === null || stage.total > stages[peak].total)) peak = index;
  });
  return peak;
}

/** Stage totals from the flow answer. Trucks waiting at the exit and trucks that left today both count under Keluar. */
export function countFlow(answer: FlowAnswer): FlowCounts {
  const stages: StageCount[] = STAGES.map((stage) => ({ ...stage, incoming: 0, outgoing: 0, total: 0 }));
  const at = (key: StageKey) => stages.find((stage) => stage.key === key) as StageCount;
  const add = (stage: StageCount, incoming: number, outgoing: number) => {
    stage.incoming += incoming;
    stage.outgoing += outgoing;
    stage.total += incoming + outgoing;
  };
  let unplaced = 0;

  add(at("upcoming"), answer.upcoming.in, answer.upcoming.out);
  for (const group of answer.inside) {
    const key = stageOfStep(group.stepCode);
    if (key) add(at(key), group.in, group.out);
    else unplaced += group.in + group.out;
  }
  add(at("exit"), answer.finishedToday.in, answer.finishedToday.out);

  return { stages, unplaced, peak: findPeak(stages) };
}

/** Trucks inside the plant in the answer, placed on a stage or not. */
export function insideTotal(answer: FlowAnswer): number {
  return answer.inside.reduce((sum, group) => sum + group.in + group.out, 0);
}

/** The same counts for one direction only ("IN", "OUT"), or both. */
export function filterFlow(counts: FlowCounts, direction: Direction | "ALL"): FlowCounts {
  if (direction === "ALL") return counts;
  const stages = counts.stages.map((stage) => {
    const kept = direction === "IN" ? stage.incoming : stage.outgoing;
    return { ...stage, incoming: direction === "IN" ? kept : 0, outgoing: direction === "OUT" ? kept : 0, total: kept };
  });
  return { stages, unplaced: counts.unplaced, peak: findPeak(stages) };
}
