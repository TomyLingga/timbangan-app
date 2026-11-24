"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";

import { Barcode } from "@/components/barcode";
import { ListError } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDateTime, formatNumber, formatQuantity } from "@/lib/format";
import { api } from "@/lib/session";
import type { SpjLine, SpjPrint } from "@/lib/types";
import { cn } from "@/lib/utils";

type Paper = "A5" | "A4";


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
  return [destination.name, destination.address, destination.district, destination.regency, destination.province].filter(Boolean).join(", ");
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
          <p className="text-xs text-neutral-600">{spj.site.name}</p>
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
          {spj.driver.fullName ?? "-"}
          <span className="block text-xs font-normal">SIM {spj.driver.licenceNo ?? "-"}</span>
        </Field>
        <Field label="Kendaraan">
          {spj.vehicle.plateDisplay ?? "-"}
          {spj.vehicle.vehicleType ? <span className="block text-xs font-normal">{spj.vehicle.vehicleType}</span> : null}
          {spj.containerNo ? <span className="block text-xs font-normal">Kontainer {spj.containerNo}</span> : null}
        </Field>
        <Field label="Transporter">{spj.transporter?.name ?? "-"}</Field>
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
              <td className="py-1.5 pr-2">{line.product.name}</td>
              <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">{formatQuantity(line.qtyPlanned, line.uom)}</td>
              <td className="py-1.5">
                {incoming ? line.partner.name : (
                  <>
                    <span className="block">{line.partner.name}</span>
                    <span className="block">{destinationText(line)}</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-end justify-between gap-5">
        <p className="text-xs text-neutral-700">
          Tunjukkan SPJ ini di pos registrasi. Petugas memindai barcode, lalu memberi kartu RFID untuk dibawa selama di dalam pabrik.
        </p>
        {spj.shareUrl ? (
          // the driver's page; a second, smaller code so the gate's scanner never takes it for the SPJ
          <div className="flex shrink-0 items-center gap-2.5 rounded-md border border-dashed border-neutral-400 p-2" data-testid="spj-share">
            <Barcode kind="qr" text={spj.shareUrl} label="QR Bagikan lokasi" className="w-[19mm] shrink-0" />
            <div className="w-[30mm]">
              <p className="text-[0.7rem] leading-tight font-semibold">Bagikan lokasi (opsional)</p>
              <p className="mt-1 text-[0.65rem] leading-snug text-neutral-700">Supir: pindai dengan kamera ponsel untuk mengirim lokasi truk selama perjalanan.</p>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function SpjPrintScreen() {
  const { tripId } = useParams<{ tripId: string }>();
  const [paper, setPaper] = useState<Paper>("A5");
  // POST .../spj/printed answers the new count; until then the count of the SPJ itself is shown.
  const [printed, setPrinted] = useState<number | null>(null);
  const query = useApiQuery(`spj|${tripId}`, (signal) =>
    api.request<{ spj: SpjPrint }>(`/api/trips/${encodeURIComponent(tripId)}/spj`, { signal }),
  );

  // Every print, from the button or from the browser menu, is counted once.
  useEffect(() => {
    const counted = () => {
      void api
        .request<{ printCount: number }>(`/api/trips/${encodeURIComponent(tripId)}/spj/printed`, { method: "POST" })
        .then((answer) => setPrinted(answer.printCount))
        .catch(() => {});
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
          {query.data ? (
            <p className="text-sm text-muted-foreground" data-testid="spj-print-count">
              Sudah dicetak {formatNumber(printed ?? query.data.spj.printCount)} kali
            </p>
          ) : null}
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
