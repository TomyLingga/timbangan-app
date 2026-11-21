"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleAlert, CircleCheck, Lock, RefreshCw, Search, SearchX, TriangleAlert, X, type LucideIcon } from "lucide-react";

import { currentEntry } from "@/components/app-shell/nav-items";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { MODULE_LABELS } from "@/lib/permissions";
import type { ModuleCode } from "@/lib/types";
import { errorMessage } from "@/lib/messages";
import { cn } from "@/lib/utils";

// Pieces every list page is built from: heading, search box, the states of a
// list (loading, failed, empty), and the count line.

/**
 * Page head: a small spaced-out line naming the menu group (taken from the
 * route unless `kicker` is given), the title, a line of key figures, then the
 * description. Actions sit on the right.
 */
export function PageHeader({
  title,
  description,
  kicker,
  figures,
  children,
}: {
  title: string;
  description?: ReactNode;
  kicker?: string;
  figures?: ReactNode;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const group = kicker ?? currentEntry(pathname)?.group ?? null;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {group ? <p className="kicker mb-2 text-primary-ink">{group}</p> : null}
        <h1 className="text-[1.75rem] leading-tight font-semibold sm:text-[2rem]">{title}</h1>
        {figures ? <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.9375rem] text-muted-foreground">{figures}</div> : null}
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-pretty text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A framed section of a page: heading row with an optional action, then content. */
export function Panel({
  title,
  icon: Icon,
  action,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  title: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className={cn("rounded-2xl border bg-card shadow-panel", className)} {...rest}>
      <div className="flex min-h-13 items-center justify-between gap-3 border-b px-4 py-2 sm:px-5">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          {title}
        </h2>
        {action}
      </div>
      <div className={cn("px-4 py-4 sm:px-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function SearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
  className,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-2 sm:max-w-sm", className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="pr-11 pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Hapus pencarian"
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

const NOTICE_TONES = {
  success: { icon: CircleCheck, classes: "border-success/30 bg-success-subtle text-success before:bg-success" },
  warning: { icon: TriangleAlert, classes: "border-warning/30 bg-warning-subtle text-warning before:bg-warning" },
  error: { icon: CircleAlert, classes: "border-destructive/30 bg-destructive-subtle text-destructive before:bg-destructive" },
} as const;

/** Result of an action (sync, save), or a caution on a form: one line with an icon. */
export function Notice({ tone, children }: { tone: "success" | "warning" | "error"; children: ReactNode }) {
  const { icon: Icon, classes } = NOTICE_TONES[tone];
  return (
    <p
      className={cn(
        "relative flex items-start gap-2 overflow-hidden rounded-md border py-2.5 pr-3 pl-4 text-sm before:absolute before:inset-y-0 before:left-0 before:w-[3px] animate-in fade-in-0 slide-in-from-top-1 duration-200",
        classes,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Icon in a small framed square, the shared mark of empty, failed and locked states. */
function StateMark({ icon: Icon, tone }: { icon: LucideIcon; tone: "neutral" | "error" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-11 items-center justify-center rounded-lg border bg-surface",
        tone === "error" ? "border-destructive/30 text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

export function ListError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="site-grid flex flex-col items-center rounded-2xl border bg-card px-4 py-12 text-center">
      <StateMark icon={CircleAlert} tone="error" />
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p role="alert" className="mt-1 max-w-md text-sm text-muted-foreground">
        {errorMessage(error)}
      </p>
      <Button variant="secondary" className="mt-5" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Coba lagi
      </Button>
    </div>
  );
}

export function ListEmpty({
  title,
  hint,
  stale,
  children,
}: {
  title: string;
  hint?: string;
  stale?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "site-grid flex flex-col items-center rounded-2xl border border-dashed border-line-strong bg-card px-4 py-12 text-center transition-opacity duration-150",
        stale && "opacity-60",
      )}
    >
      <StateMark icon={SearchX} tone="neutral" />
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      {hint ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{hint}</p> : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}

export function ListSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="hidden overflow-hidden rounded-2xl border bg-card shadow-panel md:block">
        <div className="flex h-10 items-center gap-6 border-b bg-surface px-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-2.5 w-16" />
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} className="flex h-[53px] items-center gap-6 border-b px-3 last:border-0">
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="ml-auto h-3.5 w-24" />
            <Skeleton className="h-5 w-16 rounded-sm" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: 3 }, (_, card) => (
          <div key={card} className="rounded-2xl border bg-card p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-3.5 w-32" />
            <Skeleton className="mt-5 h-3.5 w-full" />
            <Skeleton className="mt-3 h-3.5 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Lists have a limit and no offset. When more rows match than are shown, the
 * line says so and tells the user how to reach the rest.
 */
export function ResultCount({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground tabular-nums">
      {total > shown
        ? `Menampilkan ${formatNumber(shown)} dari ${formatNumber(total)} ${noun}. Persempit pencarian untuk melihat yang lain.`
        : `${formatNumber(shown)} ${noun}`}
    </p>
  );
}

/** Shown when a signed-in account opens a page of a module it has no access to. */
export function AccessDenied({ module, reason }: { module: ModuleCode; /** Replaces the default sentence. */ reason?: string }) {
  return (
    <div className="site-grid flex flex-col items-center rounded-2xl border bg-card px-4 py-14 text-center" data-testid="access-denied">
      <StateMark icon={Lock} tone="neutral" />
      <h1 className="mt-4 text-xl font-semibold">Anda tidak punya akses ke halaman ini</h1>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {reason ?? `Halaman ini bagian dari modul ${MODULE_LABELS[module]}. Minta admin sistem memberi Anda hak akses ke modul itu.`}
      </p>
      <Button asChild variant="secondary" className="mt-5">
        <Link href="/">Kembali ke Beranda</Link>
      </Button>
    </div>
  );
}
