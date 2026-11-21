"use client";

import type { FormEvent, ReactNode } from "react";
import { CircleAlert, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel?: string;
  pending: boolean;
  /** Message for a failure of the whole form, shown next to the buttons. */
  error?: string | null;
  onSubmit: () => void;
  /** Where focus goes when the sheet closes. Without it, focus returns to the button that opened it. */
  returnFocus?: () => void;
  children: ReactNode;
}

/** Side sheet holding one create or edit form. Full width on phones. */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  submitLabel = "Simpan",
  pending,
  error,
  onSubmit,
  returnFocus,
  children,
}: FormSheetProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) onSubmit();
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <SheetContent
        side="right"
        onCloseAutoFocus={
          returnFocus
            ? (event) => {
                event.preventDefault();
                returnFocus();
              }
            : undefined
        }
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="border-b px-4 py-4 pr-14 sm:px-5">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
          <SheetDescription className={description ? undefined : "sr-only"}>
            {description ?? `Formulir ${title.toLowerCase()}`}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>

          <div className="border-t px-4 py-3 sm:px-5">
            <div aria-live="polite">
              {error ? (
                <p className="mb-3 flex items-start gap-2 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Batal
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {pending ? "Menyimpan" : submitLabel}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
