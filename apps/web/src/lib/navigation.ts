// Which menu entries an account gets, in menu order: a module shows from level
// view. The page behind each entry applies the same rule on a direct visit.

import { canManageStations, canSeeApprovals, canSeeDrivers, canSeeReports, canView, isStaff } from "@/lib/permissions";
import type { ModuleCode, User } from "@/lib/types";

export type NavHref =
  | "/"
  | "/registrasi"
  | "/delivery-order"
  | "/pos"
  | "/keputusan"
  | "/kontrak"
  | "/supir"
  | "/kendaraan"
  | "/tujuan"
  | "/kartu"
  | "/laporan"
  | "/stasiun"
  | "/pengguna";

const view = (module: ModuleCode) => (user: User) => canView(user, module);

const RULES: ReadonlyArray<{ href: NavHref; visible: (user: User) => boolean }> = [
  { href: "/", visible: () => true },
  { href: "/registrasi", visible: view("registrations") },
  { href: "/delivery-order", visible: view("delivery_orders") },
  // the lists of the post (GET /api/trips) are staff only
  { href: "/pos", visible: (user) => isStaff(user) && canView(user, "gate") },
  { href: "/keputusan", visible: canSeeApprovals },
  { href: "/kontrak", visible: view("contracts") },
  { href: "/supir", visible: canSeeDrivers },
  { href: "/kendaraan", visible: view("vehicles") },
  { href: "/tujuan", visible: view("destinations") },
  { href: "/kartu", visible: view("rfid_cards") },
  { href: "/laporan", visible: canSeeReports },
  // the station list itself needs weighbridge EDIT (apps/api stations/routes.ts)
  { href: "/stasiun", visible: canManageStations },
  { href: "/pengguna", visible: view("users") },
];

export function navigationFor(user: User): NavHref[] {
  return RULES.filter((rule) => rule.visible(user)).map((rule) => rule.href);
}
