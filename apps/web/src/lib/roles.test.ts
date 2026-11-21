import { describe, expect, it } from "vitest";

import {
  awaitsRoleAssignment,
  canManageUsers,
  canSyncOdoo,
  canSyncVcf,
  canWriteDestinations,
  canWriteDrivers,
  canWriteVehicles,
  isStaff,
  roleLabel,
  roleLabels,
  rolesForKind,
  toggleRole,
} from "@/lib/roles";
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

describe("write permissions of the master data pages", () => {
  const allRoles = [
    "SUPER_ADMIN",
    "LOGISTICS_ADMIN",
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
  const allowed = (check: (candidate: User | null) => boolean) =>
    allRoles.filter((role) => check(user({ roles: [role] })));

  it("lets three roles add drivers and vehicles", () => {
    const writers = ["SUPER_ADMIN", "LOGISTICS_ADMIN", "REGISTRATION_OPERATOR"];
    expect(allowed(canWriteDrivers)).toEqual(writers);
    expect(allowed(canWriteVehicles)).toEqual(writers);
  });

  it("lets the two admin roles sync VCF and edit destinations", () => {
    expect(allowed(canSyncVcf)).toEqual(["SUPER_ADMIN", "LOGISTICS_ADMIN"]);
    expect(allowed(canWriteDestinations)).toEqual(["SUPER_ADMIN", "LOGISTICS_ADMIN"]);
  });

  it("lets only the system admin manage users", () => {
    expect(allowed(canManageUsers)).toEqual(["SUPER_ADMIN"]);
    expect(canManageUsers(null)).toBe(false);
  });
});

describe("rolesForKind", () => {
  const roles = [
    { code: "SUPER_ADMIN", name: "System admin", scope: "INTERNAL" as const },
    { code: "SECURITY", name: "Security", scope: "INTERNAL" as const },
    { code: "PARTNER_TRANSPORTER", name: "Transporter", scope: "PARTNER" as const },
  ];

  it("offers staff roles to staff accounts and partner roles to partner accounts", () => {
    expect(rolesForKind(roles, "INTERNAL").map((role) => role.code)).toEqual(["SUPER_ADMIN", "SECURITY"]);
    expect(rolesForKind(roles, "PARTNER").map((role) => role.code)).toEqual(["PARTNER_TRANSPORTER"]);
  });
});

describe("toggleRole", () => {
  it("adds a role that is missing and removes one that is present", () => {
    expect(toggleRole(["SECURITY"], "QC_OPERATOR", true)).toEqual(["SECURITY", "QC_OPERATOR"]);
    expect(toggleRole(["SECURITY", "QC_OPERATOR"], "SECURITY", false)).toEqual(["QC_OPERATOR"]);
    expect(toggleRole(["SECURITY"], "SECURITY", true)).toEqual(["SECURITY"]);
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
