"use client";

import type { YesNo } from "@/lib/cargo-marks";
import { cn } from "@/lib/utils";

/** A question with the two answers "Ya" and "Tidak" as large radio buttons; no answer is chosen at the start. */
export function YesNoField({
  legend,
  name,
  value,
  onChange,
  error,
  size = "md",
}: {
  legend: string;
  name: string;
  value: YesNo;
  onChange: (value: YesNo) => void;
  error?: string;
  /** "lg" for the registration post, where the answer is tapped on a touch screen. */
  size?: "md" | "lg";
}) {
  return (
    <fieldset aria-invalid={error ? true : undefined} className="flex flex-col gap-2">
      <legend className={cn("font-medium", size === "lg" ? "text-base" : "text-sm")}>{legend}</legend>
      <div className="flex gap-2">
        {(["yes", "no"] as const).map((option) => (
          <label
            key={option}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-4 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:flex-none",
              size === "lg" ? "min-h-13 min-w-24 text-base font-medium" : "min-h-11 text-sm",
              value === option ? "border-secondary bg-secondary text-secondary-foreground dark:border-primary dark:bg-primary dark:text-primary-foreground" : "bg-background",
              error && value !== option && "border-destructive",
            )}
          >
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="sr-only" />
            {option === "yes" ? "Ya" : "Tidak"}
          </label>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}
