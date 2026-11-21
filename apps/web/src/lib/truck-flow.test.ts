import { describe, expect, it } from "vitest";

import { countFlow, filterFlow, insideTotal, stageOfStep, STAGES, type FlowAnswer } from "@/lib/truck-flow";

const answer = (overrides: Partial<FlowAnswer> = {}): FlowAnswer => ({
  date: "2026-11-21",
  upcoming: { in: 0, out: 0 },
  inside: [],
  finishedToday: { in: 0, out: 0 },
  ...overrides,
});

describe("stageOfStep", () => {
  it("places every incoming step on a stage", () => {
    const steps = ["CHECK_IN", "SEAL_CHECK", "WEIGH_1", "QC", "UNLOADING", "TANK_CHECK", "RESEAL", "WEIGH_2", "CHECK_OUT"];
    expect(steps.map(stageOfStep)).toEqual(["gate", "gate", "weigh1", "qc", "bay", "bay", "seal", "weigh2", "exit"]);
  });

  it("places every outgoing step on a stage", () => {
    const steps = ["CHECK_IN", "WEIGH_1", "CLEANLINESS", "QC_LOADING", "LOADING", "SEALING", "WEIGH_2", "CHECK_OUT"];
    expect(steps.map(stageOfStep)).toEqual(["gate", "weigh1", "qc", "qc", "bay", "seal", "weigh2", "exit"]);
  });

  it("puts a truck without a step at the gate and leaves unknown steps out", () => {
    expect(stageOfStep(null)).toBe("gate");
    expect(stageOfStep("SEAL")).toBeNull();
    expect(stageOfStep("SOMETHING_NEW")).toBeNull();
  });
});

describe("countFlow", () => {
  it("turns the flow answer into stage totals, split by direction", () => {
    const flow = countFlow(
      answer({
        upcoming: { in: 6, out: 2 },
        inside: [
          { stepCode: "WEIGH_1", in: 3, out: 1 },
          { stepCode: null, in: 0, out: 1 },
          { stepCode: "SEAL_CHECK", in: 2, out: 0 },
          { stepCode: "TANK_CHECK", in: 1, out: 0 },
          { stepCode: "LOADING", in: 0, out: 4 },
          { stepCode: "CHECK_OUT", in: 1, out: 0 },
          { stepCode: "MYSTERY", in: 2, out: 1 },
        ],
        finishedToday: { in: 4, out: 1 },
      }),
    );
    const byKey = Object.fromEntries(flow.stages.map((stage) => [stage.key, stage]));
    expect(flow.stages.map((stage) => stage.key)).toEqual(STAGES.map((stage) => stage.key));
    expect(byKey.upcoming).toMatchObject({ incoming: 6, outgoing: 2, total: 8 });
    expect(byKey.gate).toMatchObject({ incoming: 2, outgoing: 1, total: 3 });
    expect(byKey.weigh1).toMatchObject({ incoming: 3, outgoing: 1, total: 4 });
    expect(byKey.bay).toMatchObject({ incoming: 1, outgoing: 4, total: 5 });
    expect(byKey.exit).toMatchObject({ incoming: 5, outgoing: 1, total: 6 });
    expect(flow.unplaced).toBe(3);
    expect(flow.peak).toBe(0);
  });

  it("has no peak when every stage is empty", () => {
    const flow = countFlow(answer());
    expect(flow.peak).toBeNull();
    expect(flow.unplaced).toBe(0);
    expect(flow.stages.every((stage) => stage.total === 0)).toBe(true);
  });

  it("gives a tie to the earlier stage", () => {
    expect(countFlow(answer({ upcoming: { in: 1, out: 0 }, inside: [{ stepCode: "QC", in: 1, out: 0 }] })).peak).toBe(0);
  });

  it("counts every truck inside, placed or not", () => {
    expect(insideTotal(answer({ inside: [{ stepCode: "QC", in: 2, out: 1 }, { stepCode: "MYSTERY", in: 0, out: 3 }] }))).toBe(6);
  });
});

describe("filterFlow", () => {
  it("keeps one direction and finds its own peak", () => {
    const flow = countFlow(answer({ upcoming: { in: 0, out: 2 }, inside: [{ stepCode: "QC", in: 3, out: 0 }] }));
    expect(flow.peak).toBe(3);
    const outgoing = filterFlow(flow, "OUT");
    expect(outgoing.peak).toBe(0);
    expect(outgoing.stages[3]).toMatchObject({ incoming: 0, outgoing: 0, total: 0 });
    expect(filterFlow(flow, "ALL")).toBe(flow);
  });
});
