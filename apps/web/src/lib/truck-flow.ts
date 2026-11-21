// The flow of trucks through the plant, stage by stage, counted from the trip
// lists the API already returns (GET /api/trips by status, and `currentStep`
// of the trucks inside). Nothing here is estimated: a stage shows exactly the
// trucks the lists hold.

import type { Direction, Trip } from "@/lib/types";

export type StageKey = "upcoming" | "gate" | "weigh1" | "qc" | "bay" | "seal" | "weigh2" | "exit";

export interface Stage {
  key: StageKey;
  label: string;
}

/** The stages in the order a truck passes them. */
export const STAGES: readonly Stage[] = [
  { key: "upcoming", label: "Akan datang" },
  { key: "gate", label: "Pos registrasi" },
  { key: "weigh1", label: "Timbang 1" },
  { key: "qc", label: "QC dan pemeriksaan" },
  { key: "bay", label: "Bongkar atau muat" },
  { key: "seal", label: "Segel" },
  { key: "weigh2", label: "Timbang 2" },
  { key: "exit", label: "Keluar" },
];

/**
 * Where a truck inside the plant stands, from its current step. The seal check
 * of incoming CPO counts under Segel with the sealing of outgoing loads: both
 * are about seals. A step this list does not know returns null.
 */
const STEP_STAGE: Readonly<Record<string, StageKey>> = {
  CHECK_IN: "gate",
  WEIGH_1: "weigh1",
  QC: "qc",
  UNLOADING: "bay",
  LOADING: "bay",
  SEAL_CHECK: "seal",
  SEAL: "seal",
  WEIGH_2: "weigh2",
  CHECK_OUT: "exit",
};

export function stageOfStep(step: string | null): StageKey | null {
  if (step === null) return "gate"; // checked in, no step started yet
  return STEP_STAGE[step.toUpperCase()] ?? null;
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
  /** Trucks inside whose step is not one of the stages. */
  unplaced: number;
  /** Index of the stage with the most trucks, or null when every stage is empty. Ties go to the earlier stage. */
  peak: number | null;
}

type TripLike = Pick<Trip, "direction" | "currentStep">;

/**
 * `expected`: trips with an SPJ for today that have not checked in.
 * `inside`: trips inside the plant. `done`: trips that finished today.
 */
export function countFlow(expected: readonly TripLike[], inside: readonly TripLike[], done: readonly TripLike[]): FlowCounts {
  const stages: StageCount[] = STAGES.map((stage) => ({ ...stage, incoming: 0, outgoing: 0, total: 0 }));
  const at = (key: StageKey) => stages.find((stage) => stage.key === key) as StageCount;
  const add = (stage: StageCount, direction: Direction) => {
    if (direction === "OUT") stage.outgoing += 1;
    else stage.incoming += 1;
    stage.total += 1;
  };
  let unplaced = 0;

  for (const trip of expected) add(at("upcoming"), trip.direction);
  for (const trip of inside) {
    const key = stageOfStep(trip.currentStep);
    if (key) add(at(key), trip.direction);
    else unplaced += 1;
  }
  for (const trip of done) add(at("exit"), trip.direction);

  let peak: number | null = null;
  stages.forEach((stage, index) => {
    if (stage.total > 0 && (peak === null || stage.total > stages[peak].total)) peak = index;
  });
  return { stages, unplaced, peak };
}

/** The same counts for one direction only ("IN", "OUT"), or both. */
export function filterFlow(counts: FlowCounts, direction: Direction | "ALL"): FlowCounts {
  if (direction === "ALL") return counts;
  const stages = counts.stages.map((stage) => {
    const kept = direction === "IN" ? stage.incoming : stage.outgoing;
    return { ...stage, incoming: direction === "IN" ? kept : 0, outgoing: direction === "OUT" ? kept : 0, total: kept };
  });
  let peak: number | null = null;
  stages.forEach((stage, index) => {
    if (stage.total > 0 && (peak === null || stage.total > stages[peak].total)) peak = index;
  });
  return { stages, unplaced: counts.unplaced, peak };
}
