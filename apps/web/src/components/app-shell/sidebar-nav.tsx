"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, FileText, House, IdCard, Map, PackageCheck, Truck, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  icon: LucideIcon;
}

const AVAILABLE: ReadonlyArray<NavItem & { href: string }> = [
  { href: "/", label: "Beranda", icon: House },
  { href: "/kontrak", label: "Kontrak", icon: FileText },
];

// Modules that come in later phases. Listed so people know they are planned,
// rendered as plain text so nothing leads to a page that does not exist.
const PLANNED: ReadonlyArray<NavItem> = [
  { label: "Registrasi", icon: ClipboardList },
  { label: "Delivery Order", icon: PackageCheck },
  { label: "Kendaraan", icon: Truck },
  { label: "Supir", icon: IdCard },
  { label: "Denah", icon: Map },
];

function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Menu utama" className="flex flex-1 flex-col gap-6 overflow-y-auto p-3">
      <ul className="flex flex-col gap-1">
        {AVAILABLE.map((item) => {
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
