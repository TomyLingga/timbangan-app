import { describe, expect, it } from "vitest";

import { navigationFor } from "@/lib/navigation";
import {
  canCreateIncoming,
  canCreateOutgoing,
  canManageCards,
  canManageDeliveryOrders,
  canReviewRegistrations,
  canSeeDeliveryOrders,
  canSeeRegistrations,
  canUseGate,
} from "@/lib/roles";
import type { User } from "@/lib/types";

function staff(...roles: string[]): User {
  return { id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", roles, partner: null };
}

function partner(...roles: string[]): User {
  return {
    id: "u-2",
    kind: "PARTNER",
    username: "mitra",
    fullName: "Mitra Contoh",
    roles,
    partner: { id: "p-1", name: "Mitra Contoh" },
  };
}

describe("navigationFor", () => {
  it("gives a supplier Registrasi and the pages it had", () => {
    expect(navigationFor(partner("PARTNER_SUPPLIER"))).toEqual(["/", "/registrasi", "/kontrak", "/kendaraan"]);
  });

  it("gives a transporter Delivery Order and Registrasi", () => {
    expect(navigationFor(partner("PARTNER_TRANSPORTER"))).toEqual([
      "/",
      "/registrasi",
      "/delivery-order",
      "/kontrak",
      "/kendaraan",
    ]);
  });

  it("gives a registration operator the post and Registrasi", () => {
    expect(navigationFor(staff("REGISTRATION_OPERATOR"))).toEqual([
      "/",
      "/registrasi",
      "/pos",
      "/kontrak",
      "/supir",
      "/kendaraan",
      "/tujuan",
    ]);
  });

  it("gives a logistics admin every phase 3 page", () => {
    expect(navigationFor(staff("LOGISTICS_ADMIN"))).toEqual([
      "/",
      "/registrasi",
      "/delivery-order",
      "/pos",
      "/kontrak",
      "/supir",
      "/kendaraan",
      "/tujuan",
      "/kartu",
    ]);
  });

  it("gives the system admin everything, user administration included", () => {
    expect(navigationFor(staff("SUPER_ADMIN"))).toEqual([
      "/",
      "/registrasi",
      "/delivery-order",
      "/pos",
      "/kontrak",
      "/supir",
      "/kendaraan",
      "/tujuan",
      "/kartu",
      "/pengguna",
    ]);
  });

  it("gives other staff roles no phase 3 page", () => {
    expect(navigationFor(staff("QC_OPERATOR"))).toEqual(["/", "/kontrak", "/supir", "/kendaraan", "/tujuan"]);
    expect(navigationFor(partner("PARTNER_CUSTOMER"))).toEqual(["/", "/kontrak", "/kendaraan"]);
  });
});

describe("phase 3 role checks", () => {
  it("lets suppliers and staff start an incoming registration, not transporters", () => {
    expect(canCreateIncoming(partner("PARTNER_SUPPLIER"))).toBe(true);
    expect(canCreateIncoming(staff("REGISTRATION_OPERATOR"))).toBe(true);
    expect(canCreateIncoming(partner("PARTNER_TRANSPORTER"))).toBe(false);
    expect(canCreateIncoming(staff("QC_OPERATOR"))).toBe(false);
  });

  it("lets transporters and staff fill the trucks of a delivery order, not suppliers", () => {
    expect(canCreateOutgoing(partner("PARTNER_TRANSPORTER"))).toBe(true);
    expect(canCreateOutgoing(staff("LOGISTICS_ADMIN"))).toBe(true);
    expect(canCreateOutgoing(partner("PARTNER_SUPPLIER"))).toBe(false);
  });

  it("keeps review, cards and delivery order writing with the admins", () => {
    for (const check of [canReviewRegistrations, canManageCards, canManageDeliveryOrders]) {
      expect(check(staff("LOGISTICS_ADMIN"))).toBe(true);
      expect(check(staff("SUPER_ADMIN"))).toBe(true);
      expect(check(staff("REGISTRATION_OPERATOR"))).toBe(false);
      expect(check(partner("PARTNER_TRANSPORTER"))).toBe(false);
    }
  });

  it("opens the post to operators and admins only", () => {
    expect(canUseGate(staff("REGISTRATION_OPERATOR"))).toBe(true);
    expect(canUseGate(staff("LOGISTICS_ADMIN"))).toBe(true);
    expect(canUseGate(partner("PARTNER_SUPPLIER"))).toBe(false);
  });

  it("shows lists to the roles that work with them", () => {
    expect(canSeeRegistrations(partner("PARTNER_SUPPLIER"))).toBe(true);
    expect(canSeeRegistrations(staff("QC_OPERATOR"))).toBe(false);
    expect(canSeeDeliveryOrders(partner("PARTNER_TRANSPORTER"))).toBe(true);
    expect(canSeeDeliveryOrders(partner("PARTNER_SUPPLIER"))).toBe(false);
    expect(canSeeRegistrations(null)).toBe(false);
  });
});
