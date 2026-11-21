"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { ChevronsUpDown, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { errorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import type { Page, Partner, PartnerRef, PartnerRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const OPTION_LIMIT = 8;

interface PartnerLookupProps {
  role: PartnerRole;
  label: string;
  placeholder: string;
  value: PartnerRef | null;
  onChange: (partner: PartnerRef | null) => void;
  optional?: boolean;
  error?: string;
  /** Marks the text input, so tests and password managers can tell lookups apart. */
  name: string;
  className?: string;
}

/**
 * Searchable choice of one partner (a combobox). The list comes from
 * GET /api/partners, which has a limit and no offset, so the user types to
 * narrow it instead of scrolling through everything.
 */
export function PartnerLookup({
  role,
  label,
  placeholder,
  value,
  onChange,
  optional,
  error,
  name,
  className,
}: PartnerLookupProps) {
  const id = useId();
  const listId = `${id}-list`;
  const errorId = `${id}-error`;

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);

  const search = useDebouncedValue(text.trim(), 300);
  const options = useApiQuery(
    open ? `${role}|${search}` : null,
    (signal) =>
      api.request<Page<Partner>>("/api/partners", { query: { role, q: search, limit: OPTION_LIMIT }, signal }),
    { keepPrevious: true },
  );
  const items = options.data?.items ?? [];
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  function close() {
    setOpen(false);
    setText("");
    setActive(0);
  }

  function choose(partner: Partner) {
    onChange({ id: partner.id, name: partner.name });
    close();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive(Math.min(activeIndex + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter" && open) {
      // Keep Enter from submitting the form while the list is open.
      event.preventDefault();
      const partner = items[activeIndex];
      if (partner) choose(partner);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(opsional)</span> : null}
      </Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && items[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={open ? text : (value?.name ?? "")}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="pr-11"
        />
        {value && !open ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Kosongkan ${label.toLowerCase()}`}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <ChevronsUpDown
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        )}

        {open ? (
          <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <ul id={listId} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto py-1">
              {items.map((partner, index) => (
                <li
                  key={partner.id}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  // mousedown would blur the input and close the list before the click lands
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(partner)}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex min-h-10 cursor-pointer items-center px-3 py-2 text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                >
                  {partner.name}
                </li>
              ))}
            </ul>
            <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground empty:hidden">
              {options.hasError
                ? errorMessage(options.error)
                : !options.data
                  ? "Mencari"
                  : items.length === 0
                    ? "Tidak ada yang cocok."
                    : options.data.total > items.length
                      ? `${items.length} dari ${options.data.total}. Ketik nama untuk mempersempit.`
                      : null}
            </p>
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
