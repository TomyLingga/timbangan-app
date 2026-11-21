import { describe, expect, it } from "vitest";
import { flowSteps, plateVerification } from "../src/shared/flow-steps";
import { initialScreen, type ScreenState } from "../src/shared/screen";
import { cardAnswer, weighing } from "./fixtures";

const at = (patch: Partial<ScreenState>): ScreenState => ({ ...initialScreen(0), ...patch });
const marks = (state: ScreenState) => flowSteps(state).map((step) => step.status);
const truck = { card: cardAnswer(), cardUid: "04A1B2C3D4" };

describe("flowSteps", () => {
  it("has the five steps in order", () => {
    expect(flowSteps(at({})).map((step) => step.label)).toEqual(["Tempel kartu RFID", "Data truk ditemukan", "Mencocokkan plat dengan kamera", "Berat stabil, hitung mundur", "Simpan data"]);
  });

  it.each([
    ["waiting for a card", at({ phase: "idle" }), ["current", "todo", "todo", "todo", "todo"]],
    ["reading the card", at({ phase: "lookup", cardUid: "04A1B2C3D4" }), ["done", "current", "todo", "todo", "todo"]],
    ["truck shown, plate not matched yet", at({ phase: "truck", ...truck }), ["done", "done", "current", "todo", "todo"]],
    ["camera plate matches, settling", at({ phase: "settling", ...truck, cameraPlate: "XX 1234 AB" }), ["done", "done", "done", "current", "todo"]],
    ["countdown with the plate matched", at({ phase: "countdown", ...truck, cameraPlate: "XX1234AB" }), ["done", "done", "done", "current", "todo"]],
    ["plate retry", at({ phase: "plateRetry", ...truck, cameraPlate: "XX1234AC" }), ["done", "done", "attention", "todo", "todo"]],
    ["sending", at({ phase: "sending", ...truck }), ["done", "done", "done", "done", "current"]],
    ["saved", at({ phase: "saved", ...truck, outcome: { kind: "SAVED", weighing: weighing(41_500), trip: null, afterDecision: false } }), ["done", "done", "done", "done", "done"]],
    ["waiting for a plate decision", at({ phase: "waiting", ...truck, exception: { id: 5, type: "PLATE" } }), ["done", "done", "attention", "done", "todo"]],
    ["waiting for a weight decision", at({ phase: "waiting", ...truck, exception: { id: 5, type: "GROSS_IN" } }), ["done", "done", "done", "done", "attention"]],
    ["plate rejected", at({ phase: "decided", ...truck, exception: { id: 5, type: "PLATE" }, outcome: { kind: "NOT_SAVED", reason: "REJECTED" } }), ["done", "done", "failed", "done", "todo"]],
    ["weight not saved", at({ phase: "decided", ...truck, exception: { id: 5, type: "NET_OUT" }, outcome: { kind: "NOT_SAVED", reason: "ADD_LOAD" } }), ["done", "done", "done", "done", "failed"]],
    ["card refused", at({ phase: "refused", cardUid: "FFFFFFFFFF", outcome: { kind: "REFUSED", code: "CARD_UNKNOWN" } }), ["done", "failed", "todo", "todo", "todo"]],
    ["weighing refused", at({ phase: "refused", ...truck, outcome: { kind: "REFUSED", code: "NETWORK" } }), ["done", "done", "done", "done", "failed"]],
  ] as const)("marks %s", (_name, state, expected) => {
    expect(marks(state)).toEqual(expected);
  });
});

describe("plateVerification", () => {
  it("waits for a card before anything", () => {
    expect(plateVerification(at({ phase: "idle" }))).toEqual({ attempt: 0, maxAttempts: null, plate: null, status: "WAITING_CARD" });
  });

  it("is checking while the camera has no plate yet, and compares once it has one", () => {
    expect(plateVerification(at({ phase: "truck", ...truck })).status).toBe("CHECKING");
    expect(plateVerification(at({ phase: "settling", ...truck, cameraPlate: "XX 1234 AB" })).status).toBe("SAME");
    expect(plateVerification(at({ phase: "settling", ...truck, cameraPlate: "XX 1Z34 AB" }))).toMatchObject({ status: "DIFFERENT", plate: "XX 1Z34 AB" });
  });

  it("counts the attempt being prepared while the weight settles", () => {
    expect(plateVerification(at({ phase: "truck", ...truck, plateTry: 0 })).attempt).toBe(1);
    expect(plateVerification(at({ phase: "settling", ...truck, plateTry: 1, plateAttemptsLeft: 2 }))).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });

  it("counts the attempts and knows the maximum once the API told the attempts left", () => {
    expect(plateVerification(at({ phase: "sending", ...truck, plateTry: 1 }))).toMatchObject({ attempt: 1, maxAttempts: null });
    expect(plateVerification(at({ phase: "plateRetry", ...truck, plateTry: 1, plateAttemptsLeft: 2 }))).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });

  it("uses the typed plate in manual mode, and waits for a decision on a plate request", () => {
    expect(plateVerification(at({ phase: "settling", ...truck, cameraPlate: "XX 1Z34 AB", manualPlate: "XX1234AB" }))).toMatchObject({ plate: "XX1234AB", status: "SAME" });
    expect(plateVerification(at({ phase: "waiting", ...truck, exception: { id: 5, type: "PLATE" } })).status).toBe("WAITING_DECISION");
  });
});
