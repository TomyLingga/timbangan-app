"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, Lock, RefreshCw, Search, SearchX, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { cn } from "@/lib/utils";

// Pieces every list page is built from: heading, search box, the states of a
// list (loading, failed, empty), and the count line.

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
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

/** Result of an action (sync, save): one line with an icon, announced politely. */
export function Notice({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        tone === "success"
          ? "border-success/30 bg-success-subtle text-success"
          : "border-destructive/30 bg-destructive-subtle text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function ListError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-lg border bg-card px-4 py-10 text-center">
      <CircleAlert className="size-6 text-destructive" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p role="alert" className="mt-1 max-w-md text-sm text-muted-foreground">
        {errorMessage(error)}
      </p>
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
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
        "flex flex-col items-center rounded-lg border bg-card px-4 py-10 text-center transition-opacity duration-150",
        stale && "opacity-60",
      )}
    >
      <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      {hint ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{hint}</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

export function ListSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <div className="flex h-11 items-center border-b px-3">
          <Skeleton className="h-3 w-1/3" />
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} className="flex h-[53px] items-center gap-6 border-b px-3 last:border-0">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: 3 }, (_, card) => (
          <div key={card} className="rounded-lg border bg-card p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-4 w-32" />
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-3 h-4 w-2/3" />
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
    <p role="status" className="text-sm text-muted-foreground">
      {total > shown
        ? `Menampilkan ${formatNumber(shown)} dari ${formatNumber(total)} ${noun}. Persempit pencarian untuk melihat yang lain.`
        : `${formatNumber(shown)} ${noun}`}
    </p>
  );
}

/** Shown when a signed-in account opens a page its role does not allow. */
export function AccessDenied({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border bg-card px-4 py-12 text-center">
      <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
      <h1 className="mt-3 text-base font-semibold">Halaman ini tidak tersedia untuk akun Anda</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{reason}</p>
      <Button asChild variant="secondary" className="mt-5">
        <Link href="/">Kembali ke Beranda</Link>
      </Button>
    </div>
  );
}
