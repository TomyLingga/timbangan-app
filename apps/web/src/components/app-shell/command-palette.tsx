"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { NAV_ENTRIES, NAV_GROUPS } from "@/components/app-shell/nav-items";
import { navigationFor, type NavHref } from "@/lib/navigation";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Choice {
  href: NavHref;
  label: string;
  group: string;
}

function choicesFor(user: User): Choice[] {
  const allowed = new Set(navigationFor(user));
  return NAV_GROUPS.flatMap((group) =>
    group.hrefs
      .filter((href) => allowed.has(href))
      .map((href) => ({ href, label: NAV_ENTRIES[href].label, group: group.label ?? "Umum" })),
  );
}

function matches(choice: Choice, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${choice.label} ${choice.group}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Ctrl+K (Cmd+K on a Mac): jump to any page the account may open. */
export function CommandPalette({ user, open, onOpenChange }: { user: User; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const ids = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const all = useMemo(() => choicesFor(user), [user]);
  const shown = all.filter((choice) => matches(choice, query));
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange]);

  function go(choice: Choice | undefined) {
    if (!choice) return;
    onOpenChange(false);
    router.push(choice.href);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((activeIndex + 1) % Math.max(shown.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((activeIndex - 1 + shown.length) % Math.max(shown.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(shown[activeIndex]);
    }
  }

  const optionId = (index: number) => `${ids}-option-${index}`;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.15_0.015_255/0.32)] backdrop-blur-[2px] duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 dark:bg-[oklch(0.05_0.01_255/0.6)]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-overlay duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-open:slide-in-from-top-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97]"
        >
          <DialogPrimitive.Title className="sr-only">Pindah ke halaman</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={`${ids}-list`}
              aria-activedescendant={shown.length > 0 ? optionId(activeIndex) : undefined}
              aria-label="Cari halaman"
              placeholder="Cari halaman"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              spellCheck={false}
              className="h-13 w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden shrink-0 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground sm:block">Esc</kbd>
          </div>
          <div id={`${ids}-list`} role="listbox" aria-label="Halaman" className="max-h-[min(30rem,60vh)] overflow-y-auto p-1.5">
            {shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Tidak ada halaman dengan nama itu.</p>
            ) : (
              shown.map((choice, index) => {
                const Icon = NAV_ENTRIES[choice.href].icon;
                const selected = index === activeIndex;
                return (
                  <div
                    key={choice.href}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => setActive(index)}
                    onClick={() => go(choice)}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm transition-colors duration-100",
                      selected ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                    <span className="font-medium">{choice.label}</span>
                    <span className="text-xs text-muted-foreground">{choice.group}</span>
                    {selected ? <CornerDownLeft className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                  </div>
                );
              })
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
