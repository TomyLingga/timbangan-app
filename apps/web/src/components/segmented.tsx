"use client";

import { useId } from "react";
import { LayoutGroup, motion } from "motion/react";

import { MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A pill switch between a few choices: the chosen one is filled with the
 * accent and the fill slides to the next choice. Buttons with aria-pressed,
 * reachable with Tab, inside a labelled group.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const group = useId();
  return (
    <LayoutGroup id={group}>
      <div role="group" aria-label={label} className={cn("flex h-9 w-fit max-w-full items-center gap-0.5 rounded-full border bg-surface p-0.5", className)}>
        {options.map((option) => {
          const on = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(option.value)}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                on ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {on ? <motion.span layoutId="segment" transition={MOTION_SPRING} aria-hidden="true" className="absolute inset-0 rounded-full bg-primary" /> : null}
              <span className="relative">{option.label}</span>
              {option.count !== undefined ? (
                <span className={cn("relative font-mono text-xs tabular-nums", on ? "opacity-80" : "text-faint")}>{option.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
