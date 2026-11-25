"use client";

import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { Loader2, OctagonX, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Big text box for a reader that types like a keyboard and ends with Enter: the SPJ barcode, the RFID card. */
export function ReaderInput({
  id,
  label,
  hint,
  inputRef,
  value,
  onChange,
  onEnter,
  onEscape,
  busy,
  name,
  error,
  icon: Icon,
}: {
  id: string;
  label: string;
  hint: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onEscape?: () => void;
  busy: boolean;
  name: string;
  error?: string | null;
  icon: LucideIcon;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    }
  }
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!busy) onEnter();
      }}
      className="flex flex-col gap-2.5"
    >
      <Label htmlFor={id} className="text-base font-semibold">
        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
        {label}
      </Label>
      <div className="flex gap-2">
        {/* The box that expects the next reading lights up while it has focus. */}
        <div className="group/reader relative min-w-0 flex-1">
          <Input
            ref={inputRef}
            id={id}
            name={name}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            aria-invalid={error ? true : undefined}
            className="peer h-16 border-2 pr-24 font-mono text-2xl tracking-[0.12em] uppercase rounded-xl focus-visible:border-signal focus-visible:shadow-[0_0_0_4px_color-mix(in_oklch,var(--signal)_24%,transparent),0_0_32px_-6px_color-mix(in_oklch,var(--signal)_55%,transparent)] focus-visible:ring-0 md:text-2xl"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-1.5 rounded-full bg-signal-subtle px-2.5 py-1 text-xs font-medium text-foreground peer-focus-visible:flex"
          >
            <span className="relative flex size-2">
              <span className="relative size-2 rounded-full bg-signal" />
            </span>
            Siap
          </span>
        </div>
        <Button type="submit" size="lg" className="h-16 shrink-0 rounded-xl px-6 text-base" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Enter
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-2 text-base font-medium text-destructive">
          <OctagonX className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </form>
  );
}
