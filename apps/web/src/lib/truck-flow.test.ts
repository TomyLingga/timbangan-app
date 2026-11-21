import { describe, expect, it } from "vitest";

import { countFlow, filterFlow, stageOfStep, STAGES } from "@/lib/truck-flow";

const trip = (direction: "IN" | "OUT", currentStep: string | null = null) => ({ direction, currentStep });

describe("stageOfStep", () => {
  it("places the steps of every flow on a stage", () => {
    expect(stageOfStep("WEIGH_1")).toBe("weigh1");
    expect(stageOfStep("QC")).toBe("qc");
    expect(stageOfStep("UNLOADING")).toBe("bay");
    expect(stageOfStep("LOADING")).toBe("bay");
    expect(stageOfStep("SEAL")).toBe("seal");
    expect(stageOfStep("SEAL_CHECK")).toBe("seal");
    expect(stageOfStep("WEIGH_2")).toBe("weigh2");
    expect(stageOfStep("CHECK_OUT")).toBe("exit");
  });

  it("puts a truck without a step at the post and leaves unknown steps out", () => {
    expect(stageOfStep(null)).toBe("gate");
    expect(stageOfStep("CHECK_IN")).toBe("gate");
    expect(stageOfStep("SOMETHING_NEW")).toBeNull();
  });
});

describe("countFlow", () => {
  it("counts each list into its stages, split by direction", () => {
    const flow = countFlow(
      [trip("IN"), trip("OUT")],
      [trip("IN", "UNLOADING"), trip("OUT", "LOADING"), trip("IN", "UNLOADING"), trip("IN", "MYSTERY")],
      [trip("OUT")],
    );
    const byKey = Object.fromEntries(flow.stages.map((stage) => [stage.key, stage]));
    expect(flow.stages.map((stage) => stage.key)).toEqual(STAGES.map((stage) => stage.key));
    expect(byKey.upcoming).toMatchObject({ incoming: 1, outgoing: 1, total: 2 });
    expect(byKey.bay).toMatchObject({ incoming: 2, outgoing: 1, total: 3 });
    expect(byKey.exit).toMatchObject({ incoming: 0, outgoing: 1, total: 1 });
    expect(flow.unplaced).toBe(1);
    expect(flow.peak).toBe(4);
  });

  it("has no peak when every stage is empty", () => {
    const flow = countFlow([], [], []);
    expect(flow.peak).toBeNull();
    expect(flow.stages.every((stage) => stage.total === 0)).toBe(true);
  });

  it("gives a tie to the earlier stage", () => {
    expect(countFlow([trip("IN")], [trip("IN", "QC")], []).peak).toBe(0);
  });
});

describe("filterFlow", () => {
  it("keeps one direction and finds its own peak", () => {
    const flow = countFlow([trip("OUT"), trip("OUT")], [trip("IN", "QC"), trip("IN", "QC"), trip("IN", "QC")], []);
    expect(flow.peak).toBe(3);
    const outgoing = filterFlow(flow, "OUT");
    expect(outgoing.peak).toBe(0);
    expect(outgoing.stages[3]).toMatchObject({ incoming: 0, outgoing: 0, total: 0 });
    expect(filterFlow(flow, "ALL")).toBe(flow);
  });
});
