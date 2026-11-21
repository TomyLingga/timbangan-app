import { describe, expect, it } from "vitest";

import {
  accessSummary,
  awaitsAccess,
  canAcceptDeliveryOrder,
  canAddDestination,
  canAddDriver,
  canAddVehicle,
  canCancelRegistration,
  canCreate,
  canCreateDeliveryOrder,
  canCreateIncoming,
  canCreateOutgoing,
  canEdit,
  canEditDestination,
  canEditDraft,
  canEditVehicle,
  canManageDeliveryOrders,
  canReissueSpj,
  canReviewRegistrations,
  canSeeSyncRuns,
  canSyncOdoo,
  canSyncVcf,
  canView,
  grantAll,
  isStaff,
  levelChoices,
  modulesForKind,
  permissionsPayload,
  setLevel,
} from "@/lib/permissions";
import type { ModuleDefinition, Permissions, User } from "@/lib/types";

const company = { id: "p-1", name: "Mitra Contoh", isSupplier: false, isTransporter: false, isCustomer: false };

function staff(permissions: Permissions = {}): User {
  return { id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", permissions, partner: null };
}

function partner(permissions: Permissions, kinds: Partial<typeof company> = {}): User {
  return {
    id: "u-2",
    kind: "PARTNER",
    username: "mitra",
    fullName: "Mitra Contoh",
    permissions,
    partner: { ...company, ...kinds },
  };
}

const MODULES: ModuleDefinition[] = [
  { code: "contracts", name: "Kontrak", levels: ["VIEW", "EDIT"], partnerAllowed: true },
  { code: "drivers", name: "Supir", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: true },
  { code: "gate", name: "Pos registrasi", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: false },
  { code: "users", name: "Pengguna dan hak akses", levels: ["VIEW", "EDIT"], partnerAllowed: false },
];

describe("levels are cumulative", () => {
  it("lets EDIT cover CREATE and VIEW, and CREATE cover VIEW", () => {
    const user = staff({ drivers: "EDIT", vehicles: "CREATE", contracts: "VIEW" });
    expect([canView(user, "drivers"), canCreate(user, "drivers"), canEdit(user, "drivers")]).toEqual([true, true, true]);
    expect([canView(user, "vehicles"), canCreate(user, "vehicles"), canEdit(user, "vehicles")]).toEqual([true, true, false]);
    expect([canView(user, "contracts"), canCreate(user, "contracts"), canEdit(user, "contracts")]).toEqual([true, false, false]);
  });

  it("gives nothing for a module without a level, an unknown level or a missing user", () => {
    expect(canView(staff({ drivers: "EDIT" }), "gate")).toBe(false);
    expect(canView(staff({ gate: "OWNER" as never }), "gate")).toBe(false);
    expect(canView(null, "gate")).toBe(false);
    expect(canEdit(undefined, "users")).toBe(false);
  });
});

describe("awaitsAccess", () => {
  it("is true for a staff account without any permission", () => {
    expect(awaitsAccess(staff())).toBe(true);
    expect(awaitsAccess(staff({ gate: "VIEW" }))).toBe(false);
  });

  it("is false for partner accounts and a missing user", () => {
    expect(awaitsAccess(partner({}))).toBe(false);
    expect(awaitsAccess(null)).toBe(false);
  });
});

describe("isStaff", () => {
  it("is true for internal accounts only", () => {
    expect(isStaff(staff())).toBe(true);
    expect(isStaff(partner({}))).toBe(false);
    expect(isStaff(null)).toBe(false);
  });
});

describe("actions follow the route table of the API", () => {
  it("syncs Odoo at contracts EDIT and reads sync runs at contracts or drivers VIEW, staff only", () => {
    expect(canSyncOdoo(staff({ contracts: "EDIT" }))).toBe(true);
    expect(canSyncOdoo(staff({ contracts: "VIEW" }))).toBe(false);
    expect(canSyncOdoo(partner({ contracts: "EDIT" }))).toBe(false);
    expect(canSeeSyncRuns(staff({ drivers: "VIEW" }))).toBe(true);
    expect(canSeeSyncRuns(staff({ gate: "EDIT" }))).toBe(false);
    expect(canSeeSyncRuns(partner({ contracts: "VIEW" }))).toBe(false);
  });

  it("adds drivers and vehicles from CREATE and changes vehicles and syncs VCF at EDIT, staff only", () => {
    expect(canAddDriver(staff({ drivers: "CREATE" }))).toBe(true);
    expect(canAddDriver(staff({ drivers: "VIEW" }))).toBe(false);
    expect(canAddDriver(partner({ drivers: "CREATE" }))).toBe(false);
    expect(canSyncVcf(staff({ drivers: "EDIT" }))).toBe(true);
    expect(canSyncVcf(staff({ drivers: "CREATE" }))).toBe(false);
    expect(canAddVehicle(staff({ vehicles: "CREATE" }))).toBe(true);
    expect(canAddVehicle(partner({ vehicles: "EDIT" }))).toBe(false);
    expect(canEditVehicle(staff({ vehicles: "CREATE" }))).toBe(false);
    expect(canEditVehicle(staff({ vehicles: "EDIT" }))).toBe(true);
  });

  it("adds destinations from CREATE and changes them at EDIT", () => {
    expect(canAddDestination(staff({ destinations: "CREATE" }))).toBe(true);
    expect(canEditDestination(staff({ destinations: "CREATE" }))).toBe(false);
    expect(canEditDestination(staff({ destinations: "EDIT" }))).toBe(true);
  });

  it("keeps writing a delivery order with staff and lets anyone with EDIT accept one", () => {
    expect(canCreateDeliveryOrder(staff({ delivery_orders: "CREATE" }))).toBe(true);
    expect(canCreateDeliveryOrder(partner({ delivery_orders: "EDIT" }, { isTransporter: true }))).toBe(false);
    expect(canManageDeliveryOrders(staff({ delivery_orders: "CREATE" }))).toBe(false);
    expect(canManageDeliveryOrders(staff({ delivery_orders: "EDIT" }))).toBe(true);
    expect(canAcceptDeliveryOrder(partner({ delivery_orders: "EDIT" }, { isTransporter: true }))).toBe(true);
    expect(canAcceptDeliveryOrder(partner({ delivery_orders: "VIEW" }, { isTransporter: true }))).toBe(false);
  });

  it("creates incoming registrations as staff or supplier and outgoing ones as staff or transporter", () => {
    const supplier = partner({ registrations: "CREATE" }, { isSupplier: true });
    const transporter = partner({ registrations: "CREATE" }, { isTransporter: true });
    expect([canCreateIncoming(supplier), canCreateOutgoing(supplier)]).toEqual([true, false]);
    expect([canCreateIncoming(transporter), canCreateOutgoing(transporter)]).toEqual([false, true]);
    expect([canCreateIncoming(staff({ registrations: "CREATE" })), canCreateOutgoing(staff({ registrations: "CREATE" }))]).toEqual([true, true]);
    expect(canCreateIncoming(staff({ registrations: "VIEW" }))).toBe(false);
  });

  it("approves only as staff with registrations EDIT", () => {
    expect(canReviewRegistrations(staff({ registrations: "EDIT" }))).toBe(true);
    expect(canReviewRegistrations(staff({ registrations: "CREATE" }))).toBe(false);
    expect(canReviewRegistrations(partner({ registrations: "EDIT" }, { isSupplier: true }))).toBe(false);
  });

  it("cancels a registration as its partner, as its maker, or as staff with EDIT", () => {
    const mine = { createdBy: { id: "u-1", fullName: "Staf Contoh" } };
    const theirs = { createdBy: { id: "u-9", fullName: "Orang Lain" } };
    expect(canCancelRegistration(staff({ registrations: "CREATE" }), mine)).toBe(true);
    expect(canCancelRegistration(staff({ registrations: "CREATE" }), theirs)).toBe(false);
    expect(canCancelRegistration(staff({ registrations: "EDIT" }), theirs)).toBe(true);
    expect(canCancelRegistration(partner({ registrations: "CREATE" }, { isSupplier: true }), theirs)).toBe(true);
    expect(canCancelRegistration(staff({ registrations: "VIEW" }), mine)).toBe(false);
  });

  it("changes a draft in the direction the account may write", () => {
    const supplier = partner({ registrations: "CREATE" }, { isSupplier: true });
    expect(canEditDraft(supplier, { status: "DRAFT", direction: "IN" })).toBe(true);
    expect(canEditDraft(supplier, { status: "SUBMITTED", direction: "IN" })).toBe(false);
    expect(canEditDraft(supplier, { status: "DRAFT", direction: "OUT" })).toBe(false);
  });

  it("reissues an SPJ with gate EDIT", () => {
    expect(canReissueSpj(staff({ gate: "EDIT" }))).toBe(true);
    expect(canReissueSpj(staff({ gate: "CREATE", registrations: "EDIT" }))).toBe(false);
  });
});

describe("user administration", () => {
  it("offers a partner account only the modules allowed for partners", () => {
    expect(modulesForKind(MODULES, "PARTNER").map((module) => module.code)).toEqual(["contracts", "drivers"]);
    expect(modulesForKind(MODULES, "INTERNAL")).toHaveLength(4);
  });

  it("offers the levels a module has, plus no access", () => {
    expect(levelChoices(MODULES[0]!)).toEqual([
      { value: "", label: "Tidak ada akses" },
      { value: "VIEW", label: "Lihat" },
      { value: "EDIT", label: "Lihat, buat, dan ubah" },
    ]);
  });

  it("grants the highest level of every offered module", () => {
    expect(grantAll(MODULES, "PARTNER")).toEqual({ contracts: "EDIT", drivers: "EDIT" });
    expect(grantAll(MODULES, "INTERNAL")).toEqual({ contracts: "EDIT", drivers: "EDIT", gate: "EDIT", users: "EDIT" });
  });

  it("sets and clears one level without touching the others", () => {
    expect(setLevel({ contracts: "VIEW" }, "drivers", "CREATE")).toEqual({ contracts: "VIEW", drivers: "CREATE" });
    expect(setLevel({ contracts: "VIEW", drivers: "CREATE" }, "drivers", null)).toEqual({ contracts: "VIEW" });
  });

  it("sends every offered module, null where there is no access, and leaves out the rest", () => {
    expect(permissionsPayload(MODULES, "PARTNER", { contracts: "VIEW", gate: "EDIT" })).toEqual({
      contracts: "VIEW",
      drivers: null,
    });
  });

  it("summarises the access of an account in a short line", () => {
    expect(accessSummary({}, MODULES, "INTERNAL")).toBe("Belum ada akses");
    expect(accessSummary(grantAll(MODULES, "INTERNAL"), MODULES, "INTERNAL")).toBe("Semua modul, penuh");
    expect(accessSummary({ drivers: "CREATE", contracts: "VIEW" }, MODULES, "INTERNAL")).toBe("Kontrak: lihat · Supir: buat");
    // without the module list the code is shown with a built-in label
    expect(accessSummary({ rfid_cards: "EDIT" }, [], "INTERNAL")).toBe("Kartu RFID: ubah");
  });
});
