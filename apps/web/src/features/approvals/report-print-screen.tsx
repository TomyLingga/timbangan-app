"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";

import { ListError, Notice } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { documentText, plateLines, reportTitleOf, signatureColumns, weightLines } from "@/lib/berita-acara";
import { formatDateTime } from "@/lib/format";
import { decisionsHref } from "@/lib/notifications";
import { canSeeApprovals } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { ExceptionReport, User } from "@/lib/types";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] tracking-wide text-neutral-600 uppercase">{label}</dt>
      <dd className="text-sm font-medium wrap-break-word">{children}</dd>
    </div>
  );
}

function ReportSheet({ report }: { report: ExceptionReport }) {
  const figures = [...plateLines(report), ...weightLines(report)];
  return (
    <article
      data-testid="report-sheet"
      className="mx-auto flex max-w-[210mm] flex-col gap-5 bg-white p-6 text-neutral-950 shadow-sm ring-1 ring-neutral-300 print:p-0 print:shadow-none print:ring-0"
    >
      <header className="flex items-start justify-between gap-4 border-b border-neutral-300 pb-3">
        <div className="min-w-0">
          <p className="text-xs text-neutral-600">{report.site.name}</p>
          <h1 className="text-lg leading-tight font-semibold" data-testid="report-title">
            {reportTitleOf(report)}
          </h1>
          <p className="text-xs text-neutral-600">{report.trip.direction === "IN" ? "Incoming (pembelian)" : "Outgoing (penjualan)"}</p>
        </div>
        <p className="text-right text-sm font-semibold" data-testid="report-no">
          {report.reportNo}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
        <Field label="Plat">{report.trip.plateDisplay ?? report.trip.plateNo ?? "-"}</Field>
        <Field label="Nomor trip">{report.trip.tripNo ?? "-"}</Field>
        <Field label="Supir">{report.trip.driverName ?? "-"}</Field>
        <Field label="Partner">{report.trip.partner}</Field>
        <Field label="Transporter">{report.trip.transporter ?? "-"}</Field>
        <Field label="Kontrak / DO">{documentText(report)}</Field>
        <Field label="Timbangan">{[report.station.name, report.station.code ? `(${report.station.code})` : null].filter(Boolean).join(" ") || "-"}</Field>
        <Field label="Waktu timbang">{formatDateTime(report.weighing?.weighedAt ?? report.raisedAt)}</Field>
      </dl>

      {figures.length > 0 ? (
        <table className="w-full border-collapse text-left text-sm" data-testid="report-figures">
          <tbody>
            {figures.map((line) => (
              <tr key={line.label} className="border-b border-neutral-300">
                <th scope="row" className="w-1/2 py-1.5 pr-3 font-normal text-neutral-700">
                  {line.label}
                </th>
                <td className="py-1.5 font-semibold tabular-nums">{line.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="flex flex-col gap-1 text-sm">
        <p>
          Disetujui {formatDateTime(report.decidedAt)}
          {report.decidedBy?.fullName ? ` oleh ${report.decidedBy.fullName}` : ""}.
        </p>
        {report.reason ? <p>Alasan: {report.reason}</p> : null}
        {report.masterTareUpdated ? <p>Tarra master kendaraan diganti dengan berat timbang ini.</p> : null}
      </div>

      {/* two columns only (owner, 25 November 2026): the operator who registered the truck and the approver */}
      <div className="mt-4 grid grid-cols-2 gap-8 text-center text-sm" data-testid="report-signatures">
        {signatureColumns(report).map((column) => (
          <div key={column.title} className="flex flex-col items-center" data-testid="report-signer">
            <p>{column.title}</p>
            <div className="h-20" aria-hidden="true" />
            <p className="min-h-5 w-full border-b border-neutral-500 pb-0.5 font-semibold">{column.name}</p>
            <p className="mt-1 text-xs text-neutral-600">{column.position}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function ReportView({ id }: { id: string }) {
  const query = useApiQuery(`report|${id}`, (signal) => api.request<{ report: ExceptionReport }>(`/api/exceptions/${encodeURIComponent(id)}/report`, { signal }));
  return (
    <main className="min-h-dvh bg-muted px-4 py-6 print:bg-white print:p-0">
      <style>{"@page { size: A4; margin: 15mm; }"}</style>
      <div className="mx-auto mb-5 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost">
          <Link href={decisionsHref(id)}>
            <ArrowLeft aria-hidden="true" />
            Keputusan
          </Link>
        </Button>
        <Button onClick={() => window.print()} disabled={!query.data}>
          <Printer aria-hidden="true" />
          Cetak atau simpan PDF
        </Button>
      </div>
      {query.hasError ? (
        <div className="mx-auto max-w-md">
          <ListError title="Berita Acara belum bisa dimuat" error={query.error} onRetry={query.reload} />
        </div>
      ) : !query.data ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Memuat Berita Acara
        </p>
      ) : (
        <ReportSheet report={query.data.report} />
      )}
    </main>
  );
}

function Gate({ user, id }: { user: User; id: string }) {
  if (!canSeeApprovals(user)) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <Notice tone="warning">Berita Acara hanya bisa dibuka oleh pemegang hak Keputusan.</Notice>
      </main>
    );
  }
  return <ReportView id={id} />;
}

/** /berita-acara/<id of the request>: the Berita Acara of an approved request, ready to print. */
export function ReportPrintScreen() {
  const { id } = useParams<{ id: string }>();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  return <Gate user={state.user} id={id} />;
}
