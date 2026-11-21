// The checks of a weighing, in the order of the design: the plate at every weighing, then the gross of an
// incoming truck or the tare of an outgoing one at the first weighing, the net at the second. A check runs
// only when an active exception rule exists for its type and the trip's flow; the rule names who decides.
import { eq } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { type ExceptionType, registrationAllocations, tripAllocations } from "../db/schema.js";
import { exceedsTolerance, findRule, grossTolerance, platesMatch } from "./rules.js";
import type { WeighContext } from "./service.js";
import { loadAllocations } from "./view.js";

export type CheckType = Extract<ExceptionType, "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT">;

/** How the compared figure follows from the weight on the scale. */
export type Measure = "WEIGHT" | "NET_FROM_GROSS" | "NET_FROM_TARE";

export interface Finding {
  type: CheckType;
  approverModule: string;
  expected: number | null;
  actual: number | null;
  tolerancePct: number | null;
  measure: Measure | null;
  /** The gross (NET_IN) or the tare (NET_OUT) the net is computed from. */
  baseKg: number | null;
  extra: Record<string, unknown>;
}

export function checksFor(direction: "IN" | "OUT", stage: 1 | 2): CheckType[] {
  if (stage === 1) return ["PLATE", direction === "IN" ? "GROSS_IN" : "TARE_OUT"];
  return ["PLATE", direction === "IN" ? "NET_IN" : "NET_OUT"];
}

/** The compared figure for a weight on the scale. */
export function measured(measure: Measure | null, baseKg: number | null, weightKg: number): number {
  if (measure === "NET_FROM_GROSS") return (baseKg ?? 0) - weightKg;
  if (measure === "NET_FROM_TARE") return weightKg - (baseKg ?? 0);
  return weightKg;
}

/** The figures of a check for this weight: actual, difference and difference in percent of the reference. */
export function figures(expected: number | null, measure: Measure | null, baseKg: number | null, weightKg: number) {
  const actual = measure === null ? null : measured(measure, baseKg, weightKg);
  const diff = expected === null || actual === null ? null : actual - expected;
  const diffPct = diff === null || !expected ? null : Math.round((diff / expected) * 100 * 10_000) / 10_000;
  return { actual, diff, diffPct };
}

/** The finding of one check for this weight and camera text, or null when it passes or does not apply. */
export async function runCheck(orm: Orm, context: WeighContext, type: CheckType, weightKg: number, plateRead: string | null, now: Date): Promise<Finding | null> {
  const { trip } = context;
  // a rejected truck is weighed out without a net check
  if ((type === "NET_IN" || type === "NET_OUT") && trip.outcome !== null) return null;
  const rule = await findRule(orm, trip.siteId, type, context.flowCode, now);
  if (!rule) return null;
  const finding = (fields: Partial<Finding>): Finding => ({
    type,
    approverModule: rule.approverModule,
    expected: null,
    actual: null,
    tolerancePct: null,
    measure: null,
    baseKg: null,
    extra: {},
    ...fields,
  });

  switch (type) {
    case "PLATE":
      return platesMatch(plateRead, context.plateNo) ? null : finding({});
    case "GROSS_IN": {
      const expected = trip.docGrossKg;
      if (expected === null) return null;
      const tolerances = await orm
        .select({ tolerancePct: registrationAllocations.tolerancePct })
        .from(tripAllocations)
        .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
        .where(eq(tripAllocations.tripId, trip.id));
      const pct = grossTolerance(rule.thresholdPct, tolerances.map((row) => row.tolerancePct));
      if (!exceedsTolerance(expected, weightKg, { pct, kg: rule.thresholdKg })) return null;
      return finding({ expected, actual: weightKg, tolerancePct: pct, measure: "WEIGHT" });
    }
    case "TARE_OUT": {
      const master = context.vehicle?.tareKg ?? null;
      const verified = context.vehicle?.verifiedAt != null;
      if (master !== null && verified && !exceedsTolerance(master, weightKg, { pct: rule.thresholdPct, kg: rule.thresholdKg })) return null;
      return finding({ expected: master, actual: weightKg, tolerancePct: rule.thresholdPct, measure: "WEIGHT", extra: { masterTareKg: master, vehicleVerified: verified } });
    }
    case "NET_IN": {
      const expected = trip.docNetKg;
      if (expected === null || trip.grossKg === null) return null;
      const net = trip.grossKg - weightKg;
      if (!exceedsTolerance(expected, net, { pct: rule.thresholdPct, kg: rule.thresholdKg })) return null;
      return finding({ expected, actual: net, tolerancePct: rule.thresholdPct, measure: "NET_FROM_GROSS", baseKg: trip.grossKg });
    }
    case "NET_OUT": {
      if (!context.closeCargo && !context.flexiBag) return null;
      const allocations = await loadAllocations(orm, trip.id);
      return finding({
        expected: trip.qtyPlanned,
        actual: trip.tareKg === null ? null : weightKg - trip.tareKg,
        measure: trip.tareKg === null ? null : "NET_FROM_TARE",
        baseKg: trip.tareKg,
        extra: {
          closeCargo: context.closeCargo,
          flexiBag: context.flexiBag,
          plan: allocations.map((row) => ({ seq: row.seq, doNo: row.doNo, contractNo: row.contractNo, qtyPlanned: row.qtyPlanned })),
        },
      });
    }
  }
}
