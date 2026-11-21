import type { StatusInfo, Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

// One status system for badges, steps and the plant map: a tinted chip with a
// small square marker. The label carries the meaning; colour only supports it.
const TONE_CLASSES: Record<Tone, string> = {
  success: "border-success/25 bg-success-subtle text-success",
  warning: "border-warning/25 bg-warning-subtle text-warning",
  destructive: "border-destructive/25 bg-destructive-subtle text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({ info, className }: { info: StatusInfo; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[info.tone],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-[1px] bg-current opacity-80" />
      {info.label}
    </span>
  );
}
