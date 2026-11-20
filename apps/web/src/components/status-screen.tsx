import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { AppMark } from "@/components/app-mark";

/** Full-height page for moments outside the app shell: loading, sign-in results. */
export function StatusScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <AppMark />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <StatusScreen>
      <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}
      </p>
    </StatusScreen>
  );
}
