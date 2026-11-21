"use client";

import { useMemo } from "react";
import { code128, drawingSVG, qrcode } from "bwip-js/browser";

import { cn } from "@/lib/utils";

// Barcodes are drawn in the browser with bwip-js as SVG, so they stay sharp on
// paper at any zoom. Only the two symbologies in use are imported, which lets
// the bundler leave the other encoders out.

function draw(kind: "qr" | "code128", text: string): string | null {
  try {
    return kind === "qr"
      ? qrcode({ bcid: "qrcode", text, scale: 4, padding: 0 }, drawingSVG())
      : code128({ bcid: "code128", text, scale: 2, height: 14, padding: 0 }, drawingSVG());
  } catch {
    return null;
  }
}

/**
 * A QR code or a Code 128 of `text`. The SVG comes from the encoder and the
 * text is an SPJ token (digits and capital letters only), so it is set as HTML.
 */
export function Barcode({ kind, text, label, className }: { kind: "qr" | "code128"; text: string; label: string; className?: string }) {
  const svg = useMemo(() => draw(kind, text), [kind, text]);
  if (!svg) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Barcode tidak bisa digambar.
      </p>
    );
  }
  return (
    <div
      role="img"
      aria-label={label}
      data-barcode={kind}
      className={cn("[&_svg]:block [&_svg]:h-auto [&_svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
