"use client";

import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A row of filter chips with the number of rows each choice gives: a group of
 * pill buttons with aria-pressed. The chosen chip is filled with the accent.
 */
export function FilterChips<T extends string>({
  label,
  caption,
  filters,
  selected,
  counts,
  onSelect,
}: {
  /** Accessible name of the group. */
  label: string;
  /** Short visible heading above the chips. */
  caption: string;
  filters: ReadonlyArray<{ value: T; label: string }>;
  selected: T;
  /** Count per filter value; undefined while counting. */
  counts?: Record<string, number>;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
        {caption}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const pressed = selected === filter.value;
          const count = counts?.[filter.value];
          return (
            <button
              key={filter.value || "all"}
              type="button"
              aria-pressed={pressed}
              onClick={() => onSelect(filter.value)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                pressed ? "border-transparent bg-primary font-medium text-primary-foreground" : "bg-surface text-foreground hover:border-line-strong hover:bg-muted",
              )}
            >
              {filter.label}
              <span className={cn("font-mono text-xs tabular-nums", pressed ? "opacity-80" : "text-muted-foreground")}>
                {count === undefined ? "…" : formatNumber(count)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
