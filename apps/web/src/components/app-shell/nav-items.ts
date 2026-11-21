import {
  BarChart3,
  ClipboardList,
  Gavel,
  Scale,
  CreditCard,
  FileText,
  House,
  IdCard,
  Map,
  MapPin,
  PackageCheck,
  ScanLine,
  Truck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import type { NavHref } from "@/lib/navigation";

export interface NavItem {
  label: string;
  icon: LucideIcon;
}

// Who gets which entry is decided in lib/navigation.ts; this file only says how
// an entry looks and which group it sits in.
export const NAV_ENTRIES: Readonly<Record<NavHref, NavItem>> = {
  "/": { label: "Beranda", icon: House },
  "/registrasi": { label: "Registrasi", icon: ClipboardList },
  "/delivery-order": { label: "Delivery Order", icon: PackageCheck },
  "/pos": { label: "Pos registrasi", icon: ScanLine },
  "/keputusan": { label: "Keputusan", icon: Gavel },
  "/kontrak": { label: "Kontrak", icon: FileText },
  "/supir": { label: "Supir", icon: IdCard },
  "/kendaraan": { label: "Kendaraan", icon: Truck },
  "/tujuan": { label: "Tujuan", icon: MapPin },
  "/kartu": { label: "Kartu RFID", icon: CreditCard },
  "/laporan": { label: "Laporan", icon: BarChart3 },
  "/stasiun": { label: "Stasiun", icon: Scale },
  "/pengguna": { label: "Pengguna", icon: UsersRound },
};

/**
 * Menu groups, in menu order. The order of entries across the groups is the
 * order of lib/navigation.ts, so grouping never reorders the menu.
 */
export const NAV_GROUPS: ReadonlyArray<{ label: string | null; hrefs: readonly NavHref[] }> = [
  { label: null, hrefs: ["/"] },
  { label: "Operasional", hrefs: ["/registrasi", "/delivery-order", "/pos", "/keputusan"] },
  { label: "Data induk", hrefs: ["/kontrak", "/supir", "/kendaraan", "/tujuan", "/kartu"] },
  { label: "Laporan", hrefs: ["/laporan"] },
  { label: "Sistem", hrefs: ["/stasiun", "/pengguna"] },
];

// Modules that come in later phases. Listed so people know they are planned,
// rendered as plain text so nothing leads to a page that does not exist.
export const PLANNED: ReadonlyArray<NavItem> = [{ label: "Denah", icon: Map }];

export function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The menu entry and group of the page that is open, for the top bar. */
export function currentEntry(pathname: string): { href: NavHref; item: NavItem; group: string | null } | null {
  for (const group of NAV_GROUPS) {
    for (const href of group.hrefs) {
      if (isCurrent(pathname, href)) return { href, item: NAV_ENTRIES[href], group: group.label };
    }
  }
  return null;
}
