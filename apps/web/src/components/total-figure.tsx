import { formatNumber } from "@/lib/format";

/** One key figure in the line under a page title: the number, then what it counts. */
export function TotalFigure({ value, noun }: { value: number; noun: string }) {
  return (
    <span>
      <span className="font-semibold text-foreground tabular-nums">{formatNumber(value)}</span> {noun}
    </span>
  );
}
