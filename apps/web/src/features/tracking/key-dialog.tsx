"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";

/** The key of a GPS source, shown once right after it is made. Closing the dialog is the only way out. */
export function KeyDialog({ sourceName, secret, onClose }: { sourceName: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("yes");
    } catch {
      // without clipboard access (plain HTTP, an old browser) the key is selected for Ctrl+C
      const field = document.getElementById("gps-key-value");
      if (field) window.getSelection()?.selectAllChildren(field);
      setCopied("no");
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-70 bg-[oklch(0.15_0.015_255/0.4)] backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 dark:bg-[oklch(0.05_0.01_255/0.65)]" />
        <DialogPrimitive.Content
          data-testid="gps-key-dialog"
          // the key must not vanish by a stray click outside
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed top-1/2 left-1/2 z-70 flex max-h-[92dvh] w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border bg-popover p-5 text-popover-foreground shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] sm:p-6"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-surface text-primary-ink">
              <KeyRound className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold">Kunci kiriman {sourceName}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                Berikan kunci ini ke penyedia alat. Mereka mengirimnya di header <span className="ident whitespace-nowrap">X-Tracker-Key</span> setiap kali
                mengirim posisi.
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            {/* the whole key, wrapped, so it can be read and checked character by character */}
            <p
              id="gps-key-value"
              aria-label="Kunci kiriman"
              className="ident min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2.5 text-sm leading-relaxed break-all select-all"
            >
              {secret}
            </p>
            <Button type="button" onClick={copy} className="h-11 self-start">
              {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === "yes" ? "Tersalin" : "Salin"}
            </Button>
          </div>
          <p aria-live="polite" className="-mt-2 text-xs text-muted-foreground empty:hidden">
            {copied === "no" ? "Browser tidak mengizinkan salin otomatis. Kunci sudah ditandai; tekan Ctrl+C." : ""}
          </p>

          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Kunci ini hanya tampil sekali dan tidak bisa dilihat lagi. Bila hilang, buat kunci baru; kunci lama langsung tidak berlaku. Jangan kirim kunci lewat
              grup chat.
            </span>
          </p>

          <div className="flex justify-end">
            <DialogPrimitive.Close asChild>
              <Button variant="secondary">Sudah saya simpan</Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
