"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleAlert } from "lucide-react";

import { LoadingScreen, StatusScreen } from "@/components/status-screen";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { ssoErrorMessage } from "@/lib/messages";
import { readSsoTicket, SSO_CALLBACK_PATH, type SsoTicket } from "@/lib/sso-ticket";

// The ticket works once. React's development double mount would otherwise send
// it twice and the second call would be refused, so calls are shared per token.
const exchanges = new Map<string, Promise<void>>();

function exchangeOnce(ticket: SsoTicket, run: (ticket: SsoTicket) => Promise<void>): Promise<void> {
  let exchange = exchanges.get(ticket.token);
  if (!exchange) {
    exchange = run(ticket);
    exchanges.set(ticket.token, exchange);
  }
  return exchange;
}

/** Takes the one-time token out of the address bar and the history entry. */
function removeTicketFromUrl() {
  window.history.replaceState(null, "", SSO_CALLBACK_PATH);
}

export function SsoCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, completeSso, restore } = useAuth();

  // Read once: the query is removed from the URL as soon as the exchange ends.
  const [ticket] = useState(() => readSsoTicket(searchParams.toString()));
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket) return;
    let active = true;
    exchangeOnce(ticket, completeSso).then(
      () => {
        removeTicketFromUrl();
        if (active) router.replace("/");
      },
      (error: unknown) => {
        removeTicketFromUrl();
        if (!active) return;
        setFailure(ssoErrorMessage(error));
        // The page skipped its usual session check because of the ticket.
        // Run it now, so an earlier session that is still valid is found.
        restore();
      },
    );
    return () => {
      active = false;
    };
  }, [ticket, completeSso, restore, router]);

  if (ticket && !failure) return <LoadingScreen label="Memeriksa tiket masuk dari Portal INL" />;

  const message =
    failure ?? "Tautan masuk ini tidak lengkap. Buka aplikasi ini dari Portal INL, atau masuk dari halaman masuk.";
  const hasSession = state.status === "authenticated" || state.status === "no-access";

  return (
    <StatusScreen>
      <div className="rounded-2xl border bg-card p-5 sm:p-6">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <CircleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" />
          Belum berhasil masuk
        </h1>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
        <Button asChild variant="secondary" className="mt-5">
          {hasSession ? <Link href="/">Lanjut ke Beranda</Link> : <Link href="/login">Kembali ke halaman masuk</Link>}
        </Button>
      </div>
    </StatusScreen>
  );
}
