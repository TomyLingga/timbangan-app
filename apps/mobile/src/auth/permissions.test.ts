import { describe, expect, it } from "vitest";
import type { Account } from "../api/types";
import { canCreate, canDecide, canEdit, canSendForm, canView, fieldModulesOf, seesDecisions } from "./permissions";

const user = (permissions: Account["permissions"], kind: Account["kind"] = "INTERNAL"): Account => ({
  id: 1,
  kind,
  username: "contoh",
  fullName: "Operator Contoh",
  permissions,
  partner: null,
});

describe("permissions", () => {
  it("orders VIEW < CREATE < EDIT", () => {
    const u = user({ qc: "CREATE" });
    expect(canView(u, "qc")).toBe(true);
    expect(canCreate(u, "qc")).toBe(true);
    expect(canEdit(u, "qc")).toBe(false);
    expect(canView(u, "loading")).toBe(false);
    expect(canView(null, "qc")).toBe(false);
  });

  it("lists the field modules the account sees, in plant order", () => {
    expect(fieldModulesOf(user({ sealing: "VIEW", qc: "EDIT", approvals: "EDIT" }))).toEqual(["qc", "sealing"]);
  });

  it("needs CREATE on the step's module to send a form, staff only", () => {
    expect(canSendForm(user({ qc: "VIEW" }), "qc")).toBe(false);
    expect(canSendForm(user({ qc: "CREATE" }), "qc")).toBe(true);
    expect(canSendForm(user({ qc: "EDIT" }, "PARTNER"), "qc")).toBe(false);
    expect(canSendForm(user({ qc: "EDIT" }), null)).toBe(false);
  });

  it("shows decisions to holders of approvals or qc_approvals; deciding needs EDIT on the request's module", () => {
    expect(seesDecisions(user({ qc_approvals: "VIEW" }))).toBe(true);
    expect(seesDecisions(user({ qc: "EDIT" }))).toBe(false);
    expect(canDecide(user({ approvals: "EDIT" }), "approvals")).toBe(true);
    expect(canDecide(user({ approvals: "EDIT" }), "qc_approvals")).toBe(false);
  });
});
