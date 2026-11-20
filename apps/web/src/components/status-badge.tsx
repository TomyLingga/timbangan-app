import type { StatusInfo, Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  destructive: "bg-destructive-subtle text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

/** The label carries the meaning; colour only supports it. */
export function StatusBadge({ info, className }: { info: StatusInfo; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[info.tone],
        className,
      )}
    >
      {info.label}
    </span>
  );
}
