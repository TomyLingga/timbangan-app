"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { ChevronsUpDown, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { errorMessage } from "@/lib/messages";
import type { Page } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface EntityLookupProps<T> {
  label: string;
  placeholder: string;
  /** Marks the text input, so tests and password managers can tell lookups apart. */
  name: string;
  optional?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  /** Changes when the options depend on something else (a role, a direction). */
  scope: string;
  search: (text: string, signal: AbortSignal) => Promise<Page<T>>;
  optionKey: (item: T) => string | number;
  optionLabel: (item: T) => string;
  /** Second line of an option, for telling similar names apart. */
  optionDetail?: (item: T) => string | null;
  /** Text shown while the list is closed: the chosen item, or null when none is chosen. */
  valueLabel: string | null;
  onSelect: (item: T) => void;
  /** Shows a button that empties the choice. */
  onClear?: () => void;
  /** What the user types to narrow the list, for the "x dari y" line ("nama", "nomor kontrak"). */
  narrowBy: string;
}

/**
 * Searchable choice from an API list (a combobox). Lists have a limit and no
 * offset, so the user types to narrow it instead of scrolling through everything.
 */
export function EntityLookup<T>({
  label,
  placeholder,
  name,
  optional,
  error,
  hint,
  className,
  scope,
  search,
  optionKey,
  optionLabel,
  optionDetail,
  valueLabel,
  onSelect,
  onClear,
  narrowBy,
}: EntityLookupProps<T>) {
  const id = useId();
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);

  const term = useDebouncedValue(text.trim(), 300);
  const options = useApiQuery(open ? `${scope}|${term}` : null, (signal) => search(term, signal), { keepPrevious: true });
  const items = options.data?.items ?? [];
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  function close() {
    setOpen(false);
    setText("");
    setActive(0);
  }

  function choose(item: T) {
    onSelect(item);
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
      const item = items[activeIndex];
      if (item) choose(item);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

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
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={open ? text : (valueLabel ?? "")}
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
        {valueLabel && onClear && !open ? (
          <button
            type="button"
            onClick={onClear}
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
              {items.map((item, index) => {
                const detail = optionDetail?.(item);
                return (
                  <li
                    key={optionKey(item)}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    // mousedown would blur the input and close the list before the click lands
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      "flex min-h-10 cursor-pointer flex-col justify-center px-3 py-2 text-sm",
                      index === activeIndex && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="wrap-break-word">{optionLabel(item)}</span>
                    {detail ? <span className="text-xs wrap-break-word text-muted-foreground">{detail}</span> : null}
                  </li>
                );
              })}
            </ul>
            <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground empty:hidden">
              {options.hasError
                ? errorMessage(options.error)
                : !options.data
                  ? "Mencari"
                  : items.length === 0
                    ? "Tidak ada yang cocok."
                    : options.data.total > items.length
                      ? `${items.length} dari ${options.data.total}. Ketik ${narrowBy} untuk mempersempit.`
                      : null}
            </p>
          </div>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
