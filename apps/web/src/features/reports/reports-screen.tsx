"use client";

import { useId, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField, TextField } from "@/components/form-fields";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, SearchField } from "@/components/page-parts";
import { Pager } from "@/components/pager";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlParam } from "@/hooks/use-url-filter";
import { formatDateTime, formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { canSeeReports } from "@/lib/permissions";
import { pageFromParam, pageOffset, REPORT_PAGE_SIZE, realisedText } from "@/lib/report-paging";
import { api } from "@/lib/session";
import type { ContractReportRow, ContractReportTotals, ReportPage, TripReportRow, TripReportTotals } from "@/lib/types";

type Report = "contracts" | "trips";

const PLANT_TIME_ZONE = "Asia/Jakarta";
const plantDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TIME_ZONE }).format(date);

const qty = (value: number | null, uom?: string | null) => (value === null ? "-" : `${formatNumber(value)}${uom ? ` ${uom}` : ""}`);
const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);
const DIRECTION_WORDS: Record<string, string> = { IN: "Incoming", OUT: "Outgoing" };

const CONTRACT_COLUMNS: ReadonlyArray<Column<ContractReportRow>> = [
  {
    id: "contract",
    header: "Kontrak",
    primary: true,
    cellClassName: "max-w-72 whitespace-normal",
    cell: (row) => (
      <span className="flex flex-col">
        <span className="ident font-semibold">{row.contractNo}</span>
        <span className="text-xs text-muted-foreground">
          {[DIRECTION_WORDS[row.direction] ?? row.direction, row.partner, row.product].join(", ")}
        </span>
      </span>
    ),
  },
  { id: "contracted", header: "Kontrak", align: "right", cell: (row) => <span className="font-mono">{qty(row.qtyContract, row.uom)}</span> },
  { id: "realised", header: "Realisasi periode", align: "right", cell: (row) => <span className="font-mono font-semibold">{qty(row.realised, row.uom)}</span> },
  { id: "realisedTotal", header: "Realisasi total", align: "right", cell: (row) => <span className="font-mono">{qty(row.realisedTotal, row.uom)}</span> },
  { id: "inProgress", header: "Berjalan", align: "right", cell: (row) => <span className="font-mono">{qty(row.inProgress, row.uom)}</span> },
  { id: "remaining", header: "Sisa", align: "right", cell: (row) => <span className="font-mono">{qty(row.remaining, row.uom)}</span> },
  { id: "trucks", header: "Truk", align: "right", cell: (row) => <span className="font-mono">{formatNumber(row.tripCount)}</span> },
];

const TRIP_COLUMNS: ReadonlyArray<Column<TripReportRow>> = [
  {
    id: "trip",
    header: "Truk",
    primary: true,
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <span className="plate w-fit text-[0.8125rem]">{row.plateNo ?? "-"}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {row.tripNo ?? "-"}, {DIRECTION_WORDS[row.direction] ?? row.direction}
        </span>
      </span>
    ),
  },
  {
    id: "allocation",
    header: "Kontrak atau DO",
    cellClassName: "max-w-60 whitespace-normal",
    cell: (row) => <span className="ident text-sm">{row.doNo ?? row.contractNo}</span>,
  },
  { id: "gross", header: "Bruto", align: "right", cell: (row) => <span className="font-mono">{kg(row.grossKg)}</span> },
  { id: "tare", header: "Tarra", align: "right", cell: (row) => <span className="font-mono">{kg(row.tareKg)}</span> },
  {
    id: "net",
    header: "Netto",
    align: "right",
    cell: (row) => (
      <span className="flex flex-col items-end">
        <span className="font-mono font-semibold">{kg(row.shareNetKg)}</span>
        {row.truckNetKg !== null && row.shareNetKg !== row.truckNetKg ? (
          <span className="text-xs whitespace-nowrap text-muted-foreground">dari {kg(row.truckNetKg)}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: "times",
    header: "Timbang 1 dan 2",
    cell: (row) => (
      <span className="flex flex-col text-xs tabular-nums">
        <span>{formatDateTime(row.weigh1At)}</span>
        <span className="text-muted-foreground">{row.weigh2At ? formatDateTime(row.weigh2At) : "belum"}</span>
      </span>
    ),
  },
];

function ReportsPage() {
  const ids = useId();
  const today = plantDay(new Date());
  // every filter and the page live in the address bar, so a reload or a shared link shows the same rows
  const [reportParam, setReportParam] = useUrlParam("report", "contracts");
  const report: Report = reportParam === "trips" ? "trips" : "contracts";
  const [from, setFrom] = useUrlParam("from", `${today.slice(0, 8)}01`);
  const [to, setTo] = useUrlParam("to", today);
  const [direction, setDirection] = useUrlParam("direction", "");
  const [searchText, setSearchText] = useUrlParam("q", "");
  const [allParam, setAllParam] = useUrlParam("all", "");
  const [pageParam, setPageParam] = useUrlParam("page", "1");
  const search = useDebouncedValue(searchText.trim(), 300);
  const showIdle = allParam === "1";
  const page = pageFromParam(pageParam);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Any other filter changes the rows, so the list starts again at its first page. */
  const fresh =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPageParam("1");
    };
  const goToPage = (next: number) => setPageParam(String(next));

  const periodError = from && to && from > to ? "Tanggal akhir tidak boleh sebelum tanggal awal." : null;
  const path = report === "contracts" ? "/api/reports/contracts" : "/api/reports/trips";
  const filters = {
    from: from || undefined,
    to: to || undefined,
    direction: direction || undefined,
    q: search || undefined,
    ...(report === "contracts" ? { activity: showIdle ? "all" : "moving" } : {}),
  };
  const query = { ...filters, limit: REPORT_PAGE_SIZE, offset: pageOffset(page) };
  const keyOf = `${from}|${to}|${direction}|${search}|${page}`;

  // one query per report, so a previous answer of the other report is never drawn in these columns
  const contractsQuery = useApiQuery(
    periodError || report !== "contracts" ? null : `report-contracts|${keyOf}|${showIdle}`,
    (signal) => api.request<ReportPage<ContractReportRow, ContractReportTotals>>(path, { query, signal }),
    { keepPrevious: true },
  );
  const tripsQuery = useApiQuery(
    periodError || report !== "trips" ? null : `report-trips|${keyOf}`,
    (signal) => api.request<ReportPage<TripReportRow, TripReportTotals>>(path, { query, signal }),
    { keepPrevious: true },
  );
  const data = report === "contracts" ? contractsQuery : tripsQuery;
  const answer = data.data;
  const shown = answer?.items.length ?? 0;
  const total = answer?.total ?? 0;
  const noun = report === "contracts" ? "kontrak" : "baris";

  async function download() {
    if (downloading || periodError) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      // the CSV holds every matching row, not only this page
      const { blob, fileName } = await api.download(path, { query: { ...filters, format: "csv" } });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName ?? `${report === "contracts" ? "realisasi-kontrak" : "timbang-per-truk"}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setDownloadError(errorMessage(error));
    }
    setDownloading(false);
  }

  const figure = (value: string) => <span className="font-semibold text-foreground tabular-nums">{value}</span>;
  const figures = !answer ? null : report === "contracts" ? (
    <>
      <span>
        {figure(formatNumber(total))} {showIdle ? "kontrak" : "kontrak bergerak"}
      </span>
      <span>Realisasi periode {figure(realisedText(contractsQuery.data?.totals.realisedByUom ?? []))}</span>
      <span>
        {figure(formatNumber(contractsQuery.data?.totals.tripCount ?? 0))} truk selesai
      </span>
    </>
  ) : (
    <>
      <span>{figure(formatNumber(total))} baris</span>
      <span>
        {figure(formatNumber(tripsQuery.data?.totals.tripCount ?? 0))} truk
      </span>
      <span>Netto {figure(kg(tripsQuery.data?.totals.shareNetKg ?? 0))}</span>
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Laporan"
        figures={figures}
        description="Realisasi per kontrak dan hasil timbang per truk. CSV berisi semua baris yang cocok dengan filter, bukan hanya halaman ini."
      >
        <Button variant="outline" onClick={() => void download()} disabled={downloading || Boolean(periodError)}>
          {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          Unduh CSV
        </Button>
      </PageHeader>

      <Segmented<Report>
        label="Jenis laporan"
        value={report}
        onChange={fresh(setReportParam)}
        options={[
          { value: "contracts", label: "Per kontrak" },
          { value: "trips", label: "Per truk" },
        ]}
      />

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <TextField label="Dari tanggal" name="from" type="date" value={from} onChange={fresh(setFrom)} className="w-full sm:w-44" />
        <TextField label="Sampai tanggal" name="to" type="date" value={to} onChange={fresh(setTo)} error={periodError ?? undefined} className="w-full sm:w-44" />
        <SelectField
          label="Arah"
          name="reportDirection"
          value={direction}
          onChange={fresh(setDirection)}
          emptyLabel="Semua arah"
          options={[
            { value: "IN", label: "Incoming" },
            { value: "OUT", label: "Outgoing" },
          ]}
          className="w-full sm:w-44"
        />
        <SearchField
          id={`${ids}-search`}
          label={report === "contracts" ? "Cari kontrak" : "Cari truk"}
          placeholder={report === "contracts" ? "Nomor kontrak atau partner" : "Plat, nomor trip, kontrak, atau DO"}
          value={searchText}
          onChange={fresh(setSearchText)}
        />
        {report === "contracts" ? (
          <div className="flex min-h-10 items-center gap-2.5 self-end rounded-md border bg-card px-3 shadow-panel">
            <Switch id={`${ids}-idle`} checked={showIdle} onCheckedChange={(checked) => fresh(setAllParam)(checked ? "1" : "")} />
            <Label htmlFor={`${ids}-idle`} className="cursor-pointer py-2.5 font-normal">
              Tampilkan kontrak tanpa pergerakan
            </Label>
          </div>
        ) : null}
      </div>

      <div aria-live="polite" className="empty:hidden">
        {downloadError ? <Notice tone="error">CSV belum bisa diunduh. {downloadError}</Notice> : null}
      </div>

      {periodError ? null : data.hasError && !answer ? (
        <ListError title="Laporan belum bisa dimuat" error={data.error} onRetry={data.reload} />
      ) : !answer ? (
        <ListSkeleton label="Memuat laporan" />
      ) : total === 0 ? (
        <ListEmpty
          title="Tidak ada data pada periode ini"
          hint={
            report === "trips"
              ? "Truk masuk laporan setelah timbang pertama."
              : showIdle
                ? "Ubah periode, arah, atau pencarian."
                : "Tidak ada kontrak yang bergerak. Nyalakan “Tampilkan kontrak tanpa pergerakan” untuk melihat semua kontrak."
          }
          stale={data.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3" data-testid={`report-${report}`}>
          <Pager page={page} shown={shown} total={total} noun={noun} onPage={goToPage} />
          {shown === 0 ? (
            <ListEmpty title="Halaman ini kosong" hint="Kembali ke halaman sebelumnya." stale={data.isStale} />
          ) : report === "contracts" ? (
            <DataList columns={CONTRACT_COLUMNS} rows={contractsQuery.data?.items ?? []} rowKey={(row) => row.contractId} stale={data.isStale} />
          ) : (
            <DataList columns={TRIP_COLUMNS} rows={tripsQuery.data?.items ?? []} rowKey={(row) => `${row.tripId}-${row.seq}`} stale={data.isStale} />
          )}
          {shown > 10 ? <Pager page={page} shown={shown} total={total} noun={noun} onPage={goToPage} /> : null}
        </div>
      )}
    </div>
  );
}

export function ReportsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeeReports(state.user)) return <AccessDenied module="reports" />;
  return <ReportsPage />;
}
