import { Scale } from "lucide-react";

import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * Application name with its icon. No company logo is bundled with this app.
 * `collapsible`: the name folds away with the desktop sidebar rail.
 */
export function AppMark({ className, collapsible = false }: { className?: string; collapsible?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.3)]">
        <Scale className="size-5" strokeWidth={2.1} aria-hidden="true" />
      </span>
      <span className={cn("flex min-w-0 flex-col leading-none", collapsible && "rail:sr-only")}>
        <span className="truncate font-display text-[0.9375rem] font-semibold tracking-[-0.01em]">
          {APP_NAME}
        </span>
      </span>
    </div>
  );
}
