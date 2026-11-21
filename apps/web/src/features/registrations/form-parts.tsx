"use client";

import type { ReactNode } from "react";
import { Loader2, Save, Send } from "lucide-react";

import { Notice } from "@/components/page-parts";
import { Button } from "@/components/ui/button";

/** One numbered part of a long registration form. */
export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Draft and submit buttons, kept in view at the bottom of the screen on phones. */
export function SubmitBar({
  pending,
  error,
  onDraft,
  onSubmit,
}: {
  pending: "draft" | "submit" | null;
  error: string | null;
  onDraft: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6">
      <div aria-live="polite" className="empty:hidden">
        {error ? (
          <div className="mb-3">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="lg" onClick={onDraft} disabled={pending !== null}>
          {pending === "draft" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
          Simpan draf
        </Button>
        <Button type="button" size="lg" onClick={onSubmit} disabled={pending !== null}>
          {pending === "submit" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          Kirim registrasi
        </Button>
      </div>
    </div>
  );
}

/** The errors without those whose path starts with `prefix` (the part the user just edited). */
export function dropErrors(errors: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => !key.startsWith(prefix)));
}

/** Moves focus to the first field the checks marked, after React has drawn the marks. */
export function focusFirstInvalid() {
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLElement>('main [aria-invalid="true"]');
    field?.focus();
    field?.scrollIntoView({ block: "center" });
  });
}
