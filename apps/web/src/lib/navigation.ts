// Which menu entries an account gets, in menu order: a module shows from level
// view. The page behind each entry applies the same rule on a direct visit.

import { canManageStations, canSeeApprovals, canSeeDrivers, canSeePlantMasters, canSeeReports, canView, isStaff } from "@/lib/permissions";
import type { ModuleCode, User } from "@/lib/types";

export type NavHref =
  | "/"
  | "/registrasi"
  | "/delivery-order"
  | "/pos"
  | "/ruang-kontrol"
  | "/keputusan"
  | "/kontrak"
  | "/supir"
  | "/kendaraan"
  | "/kartu"
  | "/tangki"
  | "/segel"
  | "/laporan"
  | "/riwayat"
  | "/stasiun"
  | "/pengguna";

const view = (module: ModuleCode) => (user: User) => canView(user, module);

const RULES: ReadonlyArray<{ href: NavHref; visible: (user: User) => boolean }> = [
  { href: "/", visible: () => true },
  { href: "/registrasi", visible: view("registrations") },
  { href: "/delivery-order", visible: view("delivery_orders") },
  // the lists of the post (GET /api/trips) are staff only
  { href: "/pos", visible: (user) => isStaff(user) && canView(user, "gate") },
  // the control room routes are staff only (apps/api src/control-room/routes.ts)
  { href: "/ruang-kontrol", visible: (user) => isStaff(user) && canView(user, "dashboard") },
  { href: "/keputusan", visible: canSeeApprovals },
  { href: "/kontrak", visible: view("contracts") },
  { href: "/supir", visible: canSeeDrivers },
  { href: "/kendaraan", visible: view("vehicles") },
  { href: "/kartu", visible: view("rfid_cards") },
  // tanks and seals are staff only (apps/api src/plant-masters/routes.ts)
  { href: "/tangki", visible: canSeePlantMasters },
  { href: "/segel", visible: canSeePlantMasters },
  { href: "/laporan", visible: canSeeReports },
  // the archive of the old application has the rule of the reports (apps/api src/history/routes.ts)
  { href: "/riwayat", visible: canSeeReports },
  // the station list itself needs weighbridge EDIT (apps/api stations/routes.ts)
  { href: "/stasiun", visible: canManageStations },
  { href: "/pengguna", visible: view("users") },
];

export function navigationFor(user: User): NavHref[] {
  return RULES.filter((rule) => rule.visible(user)).map((rule) => rule.href);
}
