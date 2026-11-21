"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";

import { Barcode } from "@/components/barcode";
import { ListError } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDateTime, formatQuantity } from "@/lib/format";
import { api } from "@/lib/session";
import type { PartnerRef, SpjLine, SpjPrint } from "@/lib/types";
import { cn } from "@/lib/utils";

type Paper = "A5" | "A4";

const nameOf = (value: PartnerRef | { name: string } | string | null | undefined) =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.name;

function siteName(site: SpjPrint["site"]): string | null {
  if (!site) return null;
  if (typeof site === "string") return site;
  return site.name ?? site.code ?? null;
}

/** "AB3D EF7H 9KMN": groups of four are easier to read aloud and type. */
const grouped = (token: string) => token.replace(/(.{4})(?=.)/g, "$1 ");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] tracking-wide text-neutral-600 uppercase">{label}</dt>
      <dd className="text-sm font-medium wrap-break-word">{children}</dd>
    </div>
  );
}

function destinationText(line: SpjLine): string {
  const destination = line.destination;
  if (!destination) return "-";
  if (typeof destination === "string") return destination;
  return [destination.name, destination.address].filter(Boolean).join(", ");
}

function SpjSheet({ spj, paper }: { spj: SpjPrint; paper: Paper }) {
  const incoming = spj.direction === "IN";
  return (
    <article
      data-testid="spj-sheet"
      className={cn(
        "mx-auto flex flex-col gap-5 bg-white p-6 text-neutral-950 shadow-sm ring-1 ring-neutral-300 print:p-0 print:shadow-none print:ring-0",
        paper === "A5" ? "max-w-[148mm]" : "max-w-[210mm]",
      )}
    >
      <header className="flex items-start justify-between gap-4 border-b border-neutral-300 pb-3">
        <div className="min-w-0">
          <p className="text-xs text-neutral-600">{siteName(spj.site) ?? "-"}</p>
          <h1 className="text-lg leading-tight font-semibold">Surat Pengantar Jalan</h1>
          <p className="text-xs text-neutral-600">{incoming ? "Incoming (pembelian)" : "Outgoing (penjualan)"}</p>
        </div>
        <p className="text-right text-sm font-semibold">{spj.spjNo}</p>
      </header>

      <div className="flex items-center gap-5">
        <Barcode kind="qr" text={spj.barcodeToken} label={`QR SPJ ${spj.spjNo}`} className="w-[30mm] shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <Barcode kind="code128" text={spj.barcodeToken} label={`Barcode SPJ ${spj.spjNo}`} className="w-full" />
          <p className="font-mono text-base font-semibold tracking-[0.2em]" data-testid="spj-token">
            {grouped(spj.barcodeToken)}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
        <Field label="Supir">
          {spj.driver?.fullName ?? "-"}
          <span className="block text-xs font-normal">SIM {spj.driver?.licenceNo ?? "-"}</span>
        </Field>
        <Field label="Kendaraan">
          {spj.vehicle?.plateDisplay ?? "-"}
          {spj.vehicle?.vehicleType ? <span className="block text-xs font-normal">{spj.vehicle.vehicleType}</span> : null}
        </Field>
        <Field label="Transporter">{nameOf(spj.transporter) ?? "-"}</Field>
        <Field label="Berlaku">
          {formatDateTime(spj.issuedAt)}
          <span className="block text-xs font-normal">sampai {formatDateTime(spj.validUntil)}</span>
        </Field>
      </dl>

      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-y border-neutral-400">
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Kontrak / DO
            </th>
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Barang
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">
              Rencana
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              {incoming ? "Asal" : "Tujuan"}
            </th>
          </tr>
        </thead>
        <tbody>
          {spj.lines.map((line, index) => (
            <tr key={index} className="border-b border-neutral-300 align-top">
              <td className="py-1.5 pr-2">
                {line.doNo ? <span className="block font-medium">{line.doNo}</span> : null}
                <span className="block">{line.contractNo ?? "-"}</span>
              </td>
              <td className="py-1.5 pr-2">{nameOf(line.product) ?? "-"}</td>
              <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">{formatQuantity(line.qtyPlanned, line.uom)}</td>
              <td className="py-1.5">
                {incoming ? (nameOf(line.partner) ?? "-") : (
                  <>
                    <span className="block">{nameOf(line.partner) ?? "-"}</span>
                    <span className="block">{destinationText(line)}</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-neutral-700">
        Tunjukkan SPJ ini di pos registrasi. Petugas memindai barcode, lalu memberi kartu RFID untuk dibawa selama di dalam pabrik.
      </p>
    </article>
  );
}

export function SpjPrintScreen() {
  const { tripId } = useParams<{ tripId: string }>();
  const [paper, setPaper] = useState<Paper>("A5");
  const query = useApiQuery(`spj|${tripId}`, (signal) =>
    api.request<{ spj: SpjPrint }>(`/api/trips/${encodeURIComponent(tripId)}/spj`, { signal }),
  );

  // Every print, from the button or from the browser menu, is counted once.
  useEffect(() => {
    const counted = () => {
      void api.request(`/api/trips/${encodeURIComponent(tripId)}/spj/printed`, { method: "POST" }).catch(() => {});
    };
    window.addEventListener("beforeprint", counted);
    return () => window.removeEventListener("beforeprint", counted);
  }, [tripId]);

  return (
    <main className="min-h-dvh bg-muted px-4 py-6 print:bg-white print:p-0">
      <style>{`@page { size: ${paper}; margin: 10mm; }`}</style>
      <div className="mx-auto mb-5 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost">
          <Link href="/registrasi">
            <ArrowLeft aria-hidden="true" />
            Registrasi
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Ukuran kertas" className="flex rounded-md border bg-background p-0.5">
            {(["A5", "A4"] as const).map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={paper === size}
                onClick={() => setPaper(size)}
                className={cn(
                  "min-h-9 rounded px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  paper === size ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {size}
              </button>
            ))}
          </div>
          <Button onClick={() => window.print()} disabled={!query.data}>
            <Printer aria-hidden="true" />
            Cetak atau simpan PDF
          </Button>
        </div>
      </div>
      {query.hasError ? (
        <div className="mx-auto max-w-md">
          <ListError title="SPJ belum bisa dimuat" error={query.error} onRetry={query.reload} />
        </div>
      ) : !query.data ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Memuat SPJ
        </p>
      ) : (
        <SpjSheet spj={query.data.spj} paper={paper} />
      )}
    </main>
  );
}
