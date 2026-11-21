"use client";

import { formatNumber } from "@/lib/format";
import type { ExceptionView } from "@/lib/types";
import { overTolerance, samePlate } from "@/lib/weighing";
import { cn } from "@/lib/utils";

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);
const pct = (value: number | null) => (value === null ? "-" : `${formatNumber(Math.round(value * 100) / 100)}%`);

/** The difference of a request in kg and percent, marked when it is past the tolerance. */
export function DifferenceFigure({ view }: { view: ExceptionView }) {
  if (view.diffValue === null && view.diffPct === null) return <span className="text-muted-foreground">-</span>;
  const over = overTolerance(view);
  const sign = (view.diffValue ?? 0) > 0 ? "+" : "";
  return (
    <span className="flex flex-col items-end">
      <span className={cn("font-mono font-semibold", over ? "text-destructive" : "text-foreground")}>
        {sign}
        {kg(view.diffValue)}
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {sign}
        {pct(view.diffPct)} dari toleransi {pct(view.tolerancePct)}
      </span>
    </span>
  );
}

/** The plate read by the camera next to the registered one. */
export function PlateComparison({ view }: { view: ExceptionView }) {
  const match = samePlate(view.plateRead, view.plateNo);
  return (
    <span className="flex flex-col gap-1">
      <span className="plate w-fit text-[0.8125rem]">{view.trip.plateDisplay ?? view.plateNo ?? "-"}</span>
      <span className={cn("font-mono text-xs", match ? "text-muted-foreground" : "font-semibold text-destructive")}>
        Kamera: {view.plateRead ?? "tidak terbaca"}
      </span>
    </span>
  );
}

