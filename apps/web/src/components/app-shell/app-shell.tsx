"use client";

import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, CircleAlert, Loader2, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { AppMark } from "@/components/app-mark";
import { CommandPalette } from "@/components/app-shell/command-palette";
import { currentEntry } from "@/components/app-shell/nav-items";
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
import { errorMessage } from "@/lib/messages";
import { applySidebarMode, readSidebarMode, setSidebarMode, subscribeSidebar, type SidebarMode } from "@/lib/sidebar";
import type { User } from "@/lib/types";

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

function SidebarToggle() {
  const mode = useSyncExternalStore<SidebarMode>(subscribeSidebar, readSidebarMode, () => "full");
  // Development Strict Mode resets <html> attributes on remount; production does not need this.
  useLayoutEffect(() => {
    applySidebarMode();
  }, []);
  const folded = mode === "rail";
  return (
    <button
      type="button"
      onClick={() => setSidebarMode(folded ? "full" : "rail")}
      aria-label={folded ? "Lebarkan menu" : "Ciutkan menu"}
      aria-expanded={!folded}
      className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm text-sidebar-muted transition-colors duration-150 outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/50 rail:justify-center rail:px-0"
    >
      {folded ? (
        <PanelLeftOpen className="size-[1.125rem] shrink-0" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="size-[1.125rem] shrink-0" aria-hidden="true" />
      )}
      <span className="rail:sr-only">Ciutkan menu</span>
    </button>
  );
}

/** Where the open page sits in the menu: a chip with the group, then the page. */
function PageContext() {
  const pathname = usePathname();
  const entry = currentEntry(pathname);
  if (!entry) return null;
  const deeper = pathname !== entry.href;
  return (
    <p className="flex min-w-0 items-center gap-2.5 text-sm">
      {entry.group ? (
        <span className="hidden h-7 shrink-0 items-center rounded-full border bg-surface px-3 text-xs font-medium text-muted-foreground sm:inline-flex">
          {entry.group}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 font-semibold">
        <entry.item.icon className="size-4 shrink-0 text-primary-ink sm:hidden" strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{entry.item.label}</span>
      </span>
      {deeper ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <span className="truncate text-muted-foreground">Rincian</span>
        </>
      ) : null}
    </p>
  );
}

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const { signOut } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
    <div className="min-h-dvh bg-background transition-[padding] duration-200 ease-out lg:pl-60 rail:lg:pl-[4.5rem]">
      <a
        href="#konten"
        className="sr-only z-50 rounded-md bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Lewati ke konten
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:flex rail:w-[4.5rem]">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4 rail:justify-center rail:px-0">
          <AppMark collapsible />
        </div>
        <SidebarNav user={user} />
        <div className="border-t border-sidebar-border p-2">
          <SidebarToggle />
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b bg-background/85 px-2 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 sm:px-4 lg:px-6">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Buka menu">
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 border-sidebar-border bg-sidebar p-0">
            <SheetHeader className="h-16 justify-center border-b border-sidebar-border px-4 py-0">
              <SheetTitle asChild>
                <div>
                  <AppMark />
                </div>
              </SheetTitle>
              <SheetDescription className="sr-only">Menu utama aplikasi</SheetDescription>
            </SheetHeader>
            <SidebarNav user={user} id="drawer" onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>

        <PageContext />

        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2.5">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Cari halaman"
            aria-keyshortcuts="Control+K"
            className="flex h-10 items-center gap-2.5 rounded-full border bg-surface px-4 text-sm text-muted-foreground transition-colors duration-150 outline-none hover:border-line-strong hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:size-10 max-md:justify-center max-md:border-transparent max-md:bg-transparent max-md:px-0 md:mr-auto md:ml-6 md:w-full md:max-w-md xl:ml-[8%]"
          >
            <Search className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden md:inline">Cari atau navigasi…</span>
            <kbd className="ml-auto hidden rounded-md border bg-card px-1.5 text-[0.6875rem] leading-5 md:inline">Ctrl K</kbd>
          </button>

          <ThemeToggle className="shrink-0" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="user-menu"
                aria-label={`Akun ${user.fullName}`}
                className="group/user flex h-11 min-w-0 shrink-0 items-center gap-2.5 rounded-full px-1 text-left transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted md:pr-2.5"
              >
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle font-mono text-xs font-semibold text-primary-ink ring-1 ring-primary/25"
                >
                  {initials(user.fullName)}
                </span>
                {/* Desktop and tablet: name and company stay in view. */}
                <span className="hidden min-w-0 md:block" data-testid="header-identity">
                  <span className="block max-w-[14rem] truncate text-sm leading-tight font-medium">{user.fullName}</span>
                  {identityLine ? (
                    <span className="block max-w-[14rem] truncate text-xs leading-tight text-muted-foreground" title={identityLine}>
                      {identityLine}
                    </span>
                  ) : null}
                </span>
                <ChevronDown
                  className="hidden size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded/user:rotate-180 md:block"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex flex-col gap-1 px-2 py-2 font-normal">
                <span className="text-sm font-semibold text-foreground">{user.fullName}</span>
                <span className="font-mono text-xs text-muted-foreground">{user.username}</span>
                {user.partner ? <span className="text-sm text-foreground">{user.partner.name}</span> : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-11" disabled={leaving} onSelect={() => void handleSignOut()}>
                {leaving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
                Keluar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <CommandPalette user={user} open={paletteOpen} onOpenChange={setPaletteOpen} />

      <div aria-live="assertive">
        {signOutError ? (
          <p className="flex items-start gap-2 border-b border-destructive/30 bg-destructive-subtle px-4 py-2.5 text-sm text-destructive lg:px-6">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {signOutError}
          </p>
        ) : null}
      </div>

      <main id="konten" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-6 outline-none sm:py-7 lg:px-6 lg:py-8">
        {children}
      </main>
    </div>
  );
}
