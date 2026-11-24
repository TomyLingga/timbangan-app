"use client";

import Link from "next/link";

import { STATE_GLYPHS } from "@/features/tracking/truck-map";
import { STATE_LABELS, type TruckState } from "@/lib/gps";
import { cn } from "@/lib/utils";

const STATE_TONES: Record<TruckState, string> = {
  MOVING: "border-success/25 bg-success-subtle text-success",
  STOPPED: "border-warning/25 bg-warning-subtle text-warning",
  SILENT: "border-border bg-muted text-muted-foreground",
};

/** The state of a truck as a chip: the same sign as on its map marker, and the word. */
export function TruckStateBadge({ state, className }: { state: TruckState; className?: string }) {
  return (
    <span
      data-state={state}
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium whitespace-nowrap", STATE_TONES[state], className)}
    >
      {/* fixed markup of this file, never data */}
      <span aria-hidden="true" className="flex size-3 shrink-0 [&_svg]:size-3" dangerouslySetInnerHTML={{ __html: STATE_GLYPHS[state] }} />
      {STATE_LABELS[state]}
    </span>
  );
}

/** Peta and Pengaturan GPS, for staff who may change the GPS settings. */
export function TrackingTabs({ current }: { current: "map" | "settings" }) {
  const tabs = [
    { key: "map", href: "/lacak", label: "Peta" },
    { key: "settings", href: "/lacak/pengaturan", label: "Pengaturan GPS" },
  ] as const;
  return (
    <nav aria-label="Bagian Lacak kendaraan" className="flex w-fit rounded-xl border bg-surface p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={current === tab.key ? "page" : undefined}
          className={cn(
            "inline-flex min-h-9 items-center rounded-lg px-3.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            current === tab.key ? "bg-card font-medium text-foreground shadow-panel" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
