"use client";

import { useCallback, useState } from "react";

import { isApiError } from "@/lib/api-client";
import type { FieldErrors } from "@/lib/forms";
import { FIELD_REFUSED } from "@/lib/messages";

/** Values and per-field errors of one form. Editing a field clears its error. */
export function useFormValues<T extends object>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<FieldErrors<T>>({});

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }, []);

  return { values, errors, set, setErrors };
}

/** Marks the fields the API refused. Its own wording is not shown to users. */
export function refusedFields<T>(error: unknown): FieldErrors<T> {
  if (!isApiError(error)) return {};
  return Object.fromEntries(error.fields.map((field) => [field, FIELD_REFUSED])) as FieldErrors<T>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs one request at a time and remembers whether it is still out. */
export function useAction() {
  const [pending, setPending] = useState(false);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<Outcome<T>> => {
    setPending(true);
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      return { ok: false, error };
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, run };
}
