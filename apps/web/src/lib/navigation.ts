// Which menu entries an account gets, in menu order. The page behind each
// entry applies the same rule on a direct visit.

import {
  canManageCards,
  canManageUsers,
  canSeeDeliveryOrders,
  canSeeRegistrations,
  canUseGate,
  isStaff,
} from "@/lib/roles";
import type { User } from "@/lib/types";

export type NavHref =
  | "/"
  | "/registrasi"
  | "/delivery-order"
  | "/pos"
  | "/kontrak"
  | "/supir"
  | "/kendaraan"
  | "/tujuan"
  | "/kartu"
  | "/pengguna";

const everyone = () => true;

const RULES: ReadonlyArray<{ href: NavHref; visible: (user: User) => boolean }> = [
  { href: "/", visible: everyone },
  { href: "/registrasi", visible: canSeeRegistrations },
  { href: "/delivery-order", visible: canSeeDeliveryOrders },
  { href: "/pos", visible: canUseGate },
  { href: "/kontrak", visible: everyone },
  { href: "/supir", visible: isStaff },
  { href: "/kendaraan", visible: everyone },
  { href: "/tujuan", visible: isStaff },
  { href: "/kartu", visible: canManageCards },
  { href: "/pengguna", visible: canManageUsers },
];

export function navigationFor(user: User): NavHref[] {
  return RULES.filter((rule) => rule.visible(user)).map((rule) => rule.href);
}
