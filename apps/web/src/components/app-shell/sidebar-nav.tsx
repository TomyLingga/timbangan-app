"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, motion } from "motion/react";

import {
  isCurrent,
  NAV_ENTRIES,
  NAV_GROUPS,
  PLANNED,
} from "@/components/app-shell/nav-items";
import { navigationFor } from "@/lib/navigation";
import { MOTION_SPRING } from "@/lib/motion";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

// On the desktop rail the labels stay in the accessibility tree; only their box goes away.
const railLabel = "rail:lg:sr-only";
// The name of a rail entry, shown next to it on pointer hover and keyboard focus.
const railTip =
  "pointer-events-none absolute top-1/2 left-full z-40 ml-3 hidden -translate-y-1/2 rounded-lg border bg-popover px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-popover-foreground shadow-raised rail:lg:group-hover/nav:block rail:lg:group-focus-visible/nav:block";

/**
 * The menu. `id` keeps the sliding tile of the desktop sidebar apart from the
 * one in the phone drawer, which always shows its labels.
 */
export function SidebarNav({
  user,
  onNavigate,
  id = "sidebar",
}: {
  user: User;
  onNavigate?: () => void;
  id?: string;
}) {
  const pathname = usePathname();
  const allowed = new Set(navigationFor(user));
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    hrefs: group.hrefs.filter((href) => allowed.has(href)),
  })).filter((group) => group.hrefs.length > 0);

  return (
    <nav
      aria-label="Menu utama"
      className="flex flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto px-3 py-4 rail:lg:gap-3 rail:lg:overflow-visible rail:lg:px-0"
    >
      <LayoutGroup id={id}>
        {groups.map((group, index) => (
          <div key={group.label ?? "home"}>
            {group.label ? (
              <>
                <h2 className="kicker mb-2 px-3 text-sidebar-muted rail:lg:sr-only">
                  {group.label}
                </h2>
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="mx-auto mb-3 hidden h-px w-8 bg-sidebar-border rail:lg:block"
                  />
                ) : null}
              </>
            ) : null}
            <ul className="flex flex-col gap-1 rail:lg:items-center">
              {group.hrefs.map((href) => {
                const item = NAV_ENTRIES[href];
                const current = isCurrent(pathname, href);
                return (
                  <li key={href} className="relative rail:lg:size-11">
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "group/nav relative flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm transition-colors duration-150 rail:lg:size-11 rail:lg:justify-center rail:lg:px-0",
                        current
                          ? "font-semibold text-sidebar-accent-foreground"
                          : "text-sidebar-muted hover:bg-sidebar-accent/45 hover:text-sidebar-foreground",
                      )}
                    >
                      {current ? (
                        <motion.span
                          layoutId="nav-tile"
                          transition={MOTION_SPRING}
                          aria-hidden="true"
                          className="absolute inset-0 rounded-xl bg-sidebar-accent shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--sidebar-primary)_22%,transparent)]"
                        />
                      ) : null}
                      <item.icon
                        className="relative size-[1.125rem] shrink-0"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                      <span className={cn("relative truncate", railLabel)}>
                        {item.label}
                      </span>
                      <span aria-hidden="true" className={railTip}>
                        {item.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </LayoutGroup>

      {PLANNED.length > 0 && (
        <div className="mt-auto rail:lg:hidden">
          <h2 className="kicker mb-2 px-3 text-sidebar-muted">
            Belum tersedia
          </h2>
          <ul className="flex flex-col gap-1">
            {PLANNED.map((item) => (
              <li
                key={item.label}
                className="flex min-h-10 cursor-default items-center gap-3 rounded-xl px-3 text-sm text-sidebar-muted/80"
              >
                <item.icon
                  className="size-[1.125rem] shrink-0"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                {item.label}
                <span className="ml-auto rounded-full border border-dashed border-sidebar-border px-2 text-[0.6875rem]">
                  Nanti
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
