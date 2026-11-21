"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, ServerOff } from "lucide-react";

import { AppShell } from "@/components/app-shell/app-shell";
import { LoadingScreen, StatusScreen } from "@/components/status-screen";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { NoAccessScreen } from "@/features/auth/no-access-screen";
import { errorMessage } from "@/lib/messages";
import { awaitsAccess } from "@/lib/permissions";
import { ssoForwardTarget } from "@/lib/sso-ticket";

function currentForwardTarget(): string | null {
  return ssoForwardTarget(window.location.pathname, window.location.search);
}

const subscribeNever = () => () => {};

/**
 * Wraps every signed-in route. Order matters: a portal ticket in the query is
 * forwarded to the callback page before the session is even looked at, because
 * sending an anonymous visitor to /login first would throw the ticket away.
 */
export function AuthGate({ children, bare = false }: { children: ReactNode; /** No app shell around the page (print pages). */ bare?: boolean }) {
  const router = useRouter();
  const { state, restore } = useAuth();
  const forwardTarget = useSyncExternalStore(subscribeNever, currentForwardTarget, () => null);

  useEffect(() => {
    // Read the address bar again here instead of trusting the render value,
    // so the order of the two checks cannot depend on render timing.
    const target = currentForwardTarget();
    if (target) {
      router.replace(target);
      return;
    }
    if (state.status === "anonymous") router.replace("/login");
  }, [forwardTarget, state.status, router]);

  if (forwardTarget) return <LoadingScreen label="Memeriksa tiket masuk dari Portal INL" />;

  switch (state.status) {
    case "loading":
      return <LoadingScreen label="Memeriksa sesi" />;
    case "anonymous":
      return <LoadingScreen label="Membuka halaman masuk" />;
    case "unreachable":
      return (
        <StatusScreen>
          <div className="rounded-2xl border bg-card p-5 sm:p-6">
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <ServerOff className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              Sesi belum bisa diperiksa
            </h1>
            <p role="alert" className="mt-2 text-sm text-muted-foreground">
              {errorMessage(state.error)}
            </p>
            <Button variant="secondary" className="mt-5" onClick={restore}>
              <RefreshCw aria-hidden="true" />
              Coba lagi
            </Button>
          </div>
        </StatusScreen>
      );
    case "no-access":
      return <NoAccessScreen user={null} />;
    case "authenticated":
      if (awaitsAccess(state.user)) return <NoAccessScreen user={state.user} />;
      if (bare) return <>{children}</>;
      return <AppShell user={state.user}>{children}</AppShell>;
  }
}
