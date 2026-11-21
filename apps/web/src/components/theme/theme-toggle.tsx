"use client";

import { useId, useLayoutEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";

import { applyTheme, setThemePreference, subscribeTheme } from "@/lib/theme";
import { MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Resolved = "light" | "dark";

const OPTIONS: ReadonlyArray<{ value: Resolved; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Tema terang", icon: Sun },
  { value: "dark", label: "Tema gelap", icon: Moon },
];

function readResolved(): Resolved {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Light or dark, always in view. Until the person picks one the app follows
 * the device; a pick is remembered (lib/theme.ts).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const group = useId();
  const resolved = useSyncExternalStore<Resolved | null>(subscribeTheme, readResolved, () => null);

  // In development React resets <html> attributes on the Strict Mode remount,
  // which removes the class the head script set. Production does not need this.
  useLayoutEffect(() => {
    applyTheme();
  }, []);

  return (
    <div role="group" aria-label="Tema tampilan" className={cn("relative flex h-9 items-center gap-0.5 rounded-full border bg-surface p-0.5", className)}>
      <LayoutGroup id={group}>
      {OPTIONS.map((option) => {
        const active = resolved === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            onClick={() => setThemePreference(option.value)}
            className={cn(
              "relative flex size-8 items-center justify-center rounded-full transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId="theme-thumb"
                transition={MOTION_SPRING}
                aria-hidden="true"
                className="absolute inset-0 rounded-full border bg-card shadow-panel"
              />
            ) : null}
            <option.icon className="relative size-4" aria-hidden="true" />
          </button>
        );
      })}
      </LayoutGroup>
    </div>
  );
}
