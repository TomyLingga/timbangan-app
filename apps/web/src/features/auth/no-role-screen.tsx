"use client";

import { useState } from "react";
import { Loader2, LogOut, RefreshCw, UserRoundCog } from "lucide-react";

import { StatusScreen } from "@/components/status-screen";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { errorMessage } from "@/lib/messages";
import type { User } from "@/lib/types";

/** Shown to a staff account that exists but has no role yet. */
export function NoRoleScreen({ user }: { user: User | null }) {
  const { signOut, restore } = useAuth();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setLeaving(true);
    setError(null);
    try {
      await signOut();
    } catch (failure) {
      setError(`Belum berhasil keluar. ${errorMessage(failure)}`);
      setLeaving(false);
    }
  }

  return (
    <StatusScreen>
      <div className="rounded-lg border bg-card p-5 sm:p-6">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <UserRoundCog className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Akun belum punya peran
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Akun Anda sudah terdaftar di aplikasi ini, tetapi admin sistem belum menetapkan peran. Hubungi admin sistem,
          lalu periksa lagi setelah peran ditetapkan.
        </p>

        {user ? (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">Nama</dt>
            <dd className="font-medium break-words">{user.fullName}</dd>
            <dt className="text-muted-foreground">Nama pengguna</dt>
            <dd className="break-words">{user.username}</dd>
          </dl>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={restore}>
            <RefreshCw aria-hidden="true" />
            Periksa lagi
          </Button>
          <Button variant="outline" onClick={handleSignOut} disabled={leaving}>
            {leaving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
            Keluar
          </Button>
        </div>

        <div aria-live="polite">
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </div>
      </div>
    </StatusScreen>
  );
}
