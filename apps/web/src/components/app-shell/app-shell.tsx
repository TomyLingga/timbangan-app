"use client";

import { useState, type ReactNode } from "react";
import { CircleAlert, Loader2, LogOut, Menu } from "lucide-react";

import { AppMark } from "@/components/app-mark";
import { SidebarNav } from "@/components/app-shell/sidebar-nav";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/features/auth/auth-provider";
import { APP_NAME } from "@/lib/config";
import { errorMessage } from "@/lib/messages";
import type { User } from "@/lib/types";

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const { signOut } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Second line under the name: the company for partner accounts, otherwise the account kind.
  const identityLine = user.partner?.name ?? (user.kind === "INTERNAL" ? "Karyawan" : null);

  async function handleSignOut() {
    if (leaving) return;
    setLeaving(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(`Belum berhasil keluar. ${errorMessage(error)}`);
      setLeaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background lg:pl-60">
      <a
        href="#konten"
        className="sr-only z-50 rounded-md bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Lewati ke konten
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
          <AppMark />
        </div>
        <SidebarNav user={user} />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background px-2 sm:px-4 lg:px-6">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Buka menu">
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0">
            <SheetHeader className="h-14 justify-center border-b border-sidebar-border px-4 py-0">
              <SheetTitle asChild>
                <div>
                  <AppMark />
                </div>
              </SheetTitle>
              <SheetDescription className="sr-only">Menu utama aplikasi</SheetDescription>
            </SheetHeader>
            <SidebarNav user={user} onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>

        <span className="truncate text-sm font-semibold lg:hidden">{APP_NAME}</span>

        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />

          {/* Desktop and tablet: identity and sign-out are always in view. */}
          <div className="hidden min-w-0 text-right md:block" data-testid="header-identity">
            <p className="truncate text-sm leading-tight font-medium">{user.fullName}</p>
            {identityLine ? (
              <p className="max-w-xs truncate text-xs leading-tight text-muted-foreground" title={identityLine}>
                {identityLine}
              </p>
            ) : null}
          </div>
          <Button variant="outline" className="hidden md:inline-flex" onClick={handleSignOut} disabled={leaving}>
            {leaving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
            Keluar
          </Button>

          {/* Phones: the same information behind one button. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label={`Akun ${user.fullName}`}>
                <span
                  aria-hidden="true"
                  className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold"
                >
                  {initials(user.fullName)}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
                <span className="text-sm font-semibold text-foreground">{user.fullName}</span>
                <span className="text-xs text-muted-foreground">{user.username}</span>
                {user.partner ? <span className="text-sm text-foreground">{user.partner.name}</span> : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-11" disabled={leaving} onSelect={() => void handleSignOut()}>
                <LogOut aria-hidden="true" />
                Keluar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div aria-live="assertive">
        {signOutError ? (
          <p className="flex items-start gap-2 border-b border-destructive/30 bg-destructive-subtle px-4 py-2.5 text-sm text-destructive lg:px-6">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {signOutError}
          </p>
        ) : null}
      </div>

      <main id="konten" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none lg:px-6 lg:py-8">
        {children}
      </main>
    </div>
  );
}
