import { Scale } from "lucide-react";

import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

/** Application name with its icon. No company logo is bundled with this app. */
export function AppMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Scale className="size-5" aria-hidden="true" />
      </span>
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}
