"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  FileText,
  House,
  IdCard,
  Map,
  MapPin,
  PackageCheck,
  Truck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { canManageUsers, isStaff } from "@/lib/roles";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  icon: LucideIcon;
}

interface NavLink extends NavItem {
  href: string;
  /** Who gets the entry. The page behind it applies the same rule on a direct visit. */
  visible: (user: User) => boolean;
}

const everyone = () => true;

const AVAILABLE: ReadonlyArray<NavLink> = [
  { href: "/", label: "Beranda", icon: House, visible: everyone },
  { href: "/kontrak", label: "Kontrak", icon: FileText, visible: everyone },
  { href: "/supir", label: "Supir", icon: IdCard, visible: isStaff },
  { href: "/kendaraan", label: "Kendaraan", icon: Truck, visible: everyone },
  { href: "/tujuan", label: "Tujuan", icon: MapPin, visible: isStaff },
  { href: "/pengguna", label: "Pengguna", icon: UsersRound, visible: canManageUsers },
];

// Modules that come in later phases. Listed so people know they are planned,
// rendered as plain text so nothing leads to a page that does not exist.
const PLANNED: ReadonlyArray<NavItem> = [
  { label: "Registrasi", icon: ClipboardList },
  { label: "Delivery Order", icon: PackageCheck },
  { label: "Denah", icon: Map },
];

function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ user, onNavigate }: { user: User; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Menu utama" className="flex flex-1 flex-col gap-6 overflow-y-auto p-3">
      <ul className="flex flex-col gap-1">
        {AVAILABLE.filter((item) => item.visible(user)).map((item) => {
          const current = isCurrent(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150",
                  current
                    ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                {current ? (
                  <span aria-hidden="true" className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" />
                ) : null}
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div>
        <h2 className="px-3 text-xs font-medium text-muted-foreground">Belum tersedia</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {PLANNED.map((item) => (
            <li
              key={item.label}
              className="flex min-h-10 cursor-default items-center gap-3 rounded-md px-3 text-sm text-muted-foreground/80"
            >
              <item.icon className="size-4 shrink-0" aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
