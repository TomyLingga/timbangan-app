"use client";

import { useId, type ComponentProps, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Form controls with the label above, the hint and the error below, and the
// ARIA wiring between them. Native <select>, <textarea> and checkbox are used
// on purpose: they bring the phone's own pickers and need no extra code.

const CONTROL_CLASSES =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

interface FieldShellProps {
  label: string;
  error?: string;
  hint?: string;
  /** Adds "(opsional)" after the label. Required is the default, so it gets no mark. */
  optional?: boolean;
  className?: string;
}

function useFieldIds(error?: string, hint?: string) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return { id, errorId, hintId, describedBy };
}

function FieldShell({
  id,
  errorId,
  hintId,
  label,
  error,
  hint,
  optional,
  className,
  children,
}: FieldShellProps & { id: string; errorId: string; hintId: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(opsional)</span> : null}
      </Label>
      {children}
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

type TextFieldProps = FieldShellProps &
  Omit<ComponentProps<"input">, "onChange" | "value" | "className" | "id"> & {
    value: string;
    onChange: (value: string) => void;
  };

export function TextField({ label, error, hint, optional, className, value, onChange, ...input }: TextFieldProps) {
  const ids = useFieldIds(error, hint);
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint} optional={optional} className={className}>
      <Input
        id={ids.id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        autoComplete="off"
        {...input}
      />
    </FieldShell>
  );
}

type TextAreaFieldProps = FieldShellProps &
  Omit<ComponentProps<"textarea">, "onChange" | "value" | "className" | "id"> & {
    value: string;
    onChange: (value: string) => void;
  };

export function TextAreaField({ label, error, hint, optional, className, value, onChange, ...area }: TextAreaFieldProps) {
  const ids = useFieldIds(error, hint);
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint} optional={optional} className={className}>
      <textarea
        id={ids.id}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cn(CONTROL_CLASSES, "min-h-20 py-2")}
        {...area}
      />
    </FieldShell>
  );
}

type SelectFieldProps = FieldShellProps & {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** Label of the empty choice. */
  emptyLabel: string;
  disabled?: boolean;
};

export function SelectField({
  label,
  error,
  hint,
  optional,
  className,
  name,
  value,
  onChange,
  options,
  emptyLabel,
  disabled,
}: SelectFieldProps) {
  const ids = useFieldIds(error, hint);
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint} optional={optional} className={className}>
      <select
        id={ids.id}
        name={name}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cn(CONTROL_CLASSES, "h-10")}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField({
  label,
  description,
  name,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start gap-3 py-2">
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={description ? `${id}-description` : undefined}
        className="mt-0.5 size-5 shrink-0 cursor-pointer rounded accent-secondary outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed dark:accent-primary"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          {label}
        </label>
        {description ? (
          <p id={`${id}-description`} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
