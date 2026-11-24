import { describe, expect, it } from "vitest";

import { navigationFor } from "@/lib/navigation";
import type { Permissions, User } from "@/lib/types";

function staff(permissions: Permissions): User {
  return { id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", permissions, partner: null };
}

function partner(permissions: Permissions): User {
  return {
    id: "u-2",
    kind: "PARTNER",
    username: "mitra",
    fullName: "Mitra Contoh",
    permissions,
    partner: { id: "p-1", name: "Mitra Contoh", isSupplier: true, isTransporter: false, isCustomer: false },
  };
}

const EVERYTHING: Permissions = {
  contracts: "EDIT",
  drivers: "EDIT",
  vehicles: "EDIT",
  delivery_orders: "EDIT",
  registrations: "EDIT",
  gate: "EDIT",
  rfid_cards: "EDIT",
  users: "EDIT",
};

describe("navigationFor", () => {
  it("shows a module from level view, in menu order", () => {
    expect(navigationFor(staff(EVERYTHING))).toEqual([
      "/",
      "/registrasi",
      "/delivery-order",
      "/pos",
      "/kontrak",
      "/supir",
      "/kendaraan",
      "/kartu",
      "/pengguna",
    ]);
  });

  it("shows only the modules the account may view", () => {
    expect(navigationFor(staff({ gate: "VIEW", registrations: "VIEW" }))).toEqual(["/", "/registrasi", "/pos"]);
    expect(navigationFor(staff({ users: "VIEW" }))).toEqual(["/", "/pengguna"]);
  });

  it("gives a supplier the pages of its default access", () => {
    expect(navigationFor(partner({ contracts: "VIEW", registrations: "CREATE", vehicles: "CREATE", drivers: "CREATE" }))).toEqual([
      "/",
      "/registrasi",
      "/kontrak",
      "/kendaraan",
    ]);
  });

  it("keeps the staff-only pages from partner accounts whatever their level", () => {
    // the driver list and the post list trips of every company, so the API refuses partners
    expect(navigationFor(partner({ drivers: "EDIT", gate: "EDIT" }))).toEqual(["/"]);
  });

  it("adds the weighing pages for the modules of phase 4", () => {
    expect(navigationFor(staff({ approvals: "VIEW", reports: "VIEW", weighbridge: "EDIT" }))).toEqual(["/", "/keputusan", "/laporan", "/riwayat", "/stasiun"]);
    expect(navigationFor(staff({ dashboard: "VIEW" }))).toEqual(["/", "/ruang-kontrol"]);
    // the station list needs the edit level
    expect(navigationFor(staff({ weighbridge: "VIEW" }))).toEqual(["/"]);
    expect(navigationFor(partner({ approvals: "EDIT", reports: "VIEW" }))).toEqual(["/"]);
  });

  it("adds the tank and seal pages for staff with plant_masters", () => {
    expect(navigationFor(staff({ plant_masters: "VIEW" }))).toEqual(["/", "/tangki", "/segel"]);
    expect(navigationFor(staff({ rfid_cards: "VIEW", plant_masters: "EDIT", reports: "VIEW" }))).toEqual(["/", "/kartu", "/tangki", "/segel", "/laporan", "/riwayat"]);
    expect(navigationFor(partner({ plant_masters: "EDIT" }))).toEqual(["/"]);
  });

  it("gives an account without access only the start page", () => {
    expect(navigationFor(staff({}))).toEqual(["/"]);
  });
});
