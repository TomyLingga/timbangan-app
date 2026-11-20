import { describe, expect, it } from "vitest";

import { awaitsRoleAssignment, canSyncOdoo, isStaff, roleLabel, roleLabels } from "@/lib/roles";
import type { User } from "@/lib/types";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    kind: "INTERNAL",
    username: "contoh",
    fullName: "Pengguna Contoh",
    roles: [],
    partner: null,
    ...overrides,
  };
}

describe("roleLabel", () => {
  it("maps every known role to its Indonesian label", () => {
    expect(roleLabel("SUPER_ADMIN")).toBe("Admin sistem");
    expect(roleLabel("LOGISTICS_ADMIN")).toBe("Admin logistik");
    expect(roleLabel("REGISTRATION_OPERATOR")).toBe("Pos registrasi");
    expect(roleLabel("LOGISTICS_SUPERVISOR")).toBe("Atasan logistik");
    expect(roleLabel("QC_OPERATOR")).toBe("QC");
    expect(roleLabel("QC_SUPERVISOR")).toBe("Supervisor QC");
    expect(roleLabel("SECURITY")).toBe("Security");
    expect(roleLabel("UNLOADING_OPERATOR")).toBe("Bongkar");
    expect(roleLabel("LOADING_OPERATOR")).toBe("Muat");
    expect(roleLabel("SEAL_OPERATOR")).toBe("Segel");
    expect(roleLabel("MANAGEMENT")).toBe("Manajemen");
    expect(roleLabel("PARTNER_SUPPLIER")).toBe("PKS / supplier");
    expect(roleLabel("PARTNER_TRANSPORTER")).toBe("Transporter");
    expect(roleLabel("PARTNER_CUSTOMER")).toBe("Customer");
  });

  it("shows an unknown role code as it is", () => {
    expect(roleLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("roleLabels", () => {
  it("keeps the order and drops duplicates", () => {
    expect(roleLabels(["LOGISTICS_ADMIN", "QC_OPERATOR", "LOGISTICS_ADMIN"])).toEqual(["Admin logistik", "QC"]);
    expect(roleLabels([])).toEqual([]);
  });
});

describe("canSyncOdoo", () => {
  it("allows system admins and logistics admins", () => {
    expect(canSyncOdoo(user({ roles: ["SUPER_ADMIN"] }))).toBe(true);
    expect(canSyncOdoo(user({ roles: ["QC_OPERATOR", "LOGISTICS_ADMIN"] }))).toBe(true);
  });

  it("refuses every other role", () => {
    const others = [
      "REGISTRATION_OPERATOR",
      "LOGISTICS_SUPERVISOR",
      "QC_OPERATOR",
      "QC_SUPERVISOR",
      "SECURITY",
      "UNLOADING_OPERATOR",
      "LOADING_OPERATOR",
      "SEAL_OPERATOR",
      "MANAGEMENT",
      "PARTNER_SUPPLIER",
      "PARTNER_TRANSPORTER",
      "PARTNER_CUSTOMER",
    ];
    for (const role of others) {
      expect(canSyncOdoo(user({ roles: [role] })), role).toBe(false);
    }
  });

  it("refuses a user without roles and a missing user", () => {
    expect(canSyncOdoo(user())).toBe(false);
    expect(canSyncOdoo(null)).toBe(false);
  });
});

describe("isStaff", () => {
  it("is true for internal accounts only", () => {
    expect(isStaff(user())).toBe(true);
    expect(isStaff(user({ kind: "PARTNER", partner: { id: "p-1", name: "PKS Contoh A" } }))).toBe(false);
    expect(isStaff(null)).toBe(false);
  });
});

describe("awaitsRoleAssignment", () => {
  it("is true for a staff account with no role", () => {
    expect(awaitsRoleAssignment(user({ roles: [] }))).toBe(true);
  });

  it("is false once a role is assigned", () => {
    expect(awaitsRoleAssignment(user({ roles: ["SECURITY"] }))).toBe(false);
  });

  it("is false for partner accounts and a missing user", () => {
    expect(awaitsRoleAssignment(user({ kind: "PARTNER", roles: [] }))).toBe(false);
    expect(awaitsRoleAssignment(null)).toBe(false);
  });
});
