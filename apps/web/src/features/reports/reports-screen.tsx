"use client";

import { useId, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField, TextField } from "@/components/form-fields";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDateTime, formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { canSeeReports } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { ContractReportRow, TripReportRow } from "@/lib/types";

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
  const [report, setReport] = useState<Report>("contracts");
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [direction, setDirection] = useState("");
  const [searchText, setSearchText] = useState("");
  const search = useDebouncedValue(searchText.trim(), 300);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const periodError = from && to && from > to ? "Tanggal akhir tidak boleh sebelum tanggal awal." : null;
  const path = report === "contracts" ? "/api/reports/contracts" : "/api/reports/trips";
  // the trip report has no search on the server; it is narrowed here
  const query = { from: from || undefined, to: to || undefined, direction: direction || undefined, ...(report === "contracts" ? { q: search || undefined } : {}) };

  // one query per report, so a previous answer of the other report is never drawn in these columns
  const contractsQuery = useApiQuery(
    periodError || report !== "contracts" ? null : `report-contracts|${from}|${to}|${direction}|${search}`,
    (signal) => api.request<{ items: ContractReportRow[] }>(path, { query, signal }),
    { keepPrevious: true },
  );
  const tripsQuery = useApiQuery(
    periodError || report !== "trips" ? null : `report-trips|${from}|${to}|${direction}`,
    (signal) => api.request<{ items: TripReportRow[] }>(path, { query, signal }),
    { keepPrevious: true },
  );
  const data = report === "contracts" ? contractsQuery : tripsQuery;

  const rows = data.data?.items ?? [];
  const tripRows = (rows as TripReportRow[]).filter((row) => {
    if (report !== "trips" || !search) return true;
    const needle = search.toLowerCase().replace(/\s+/g, "");
    return [row.plateNo, row.tripNo, row.contractNo, row.doNo].some((value) => (value ?? "").toLowerCase().replace(/\s+/g, "").includes(needle));
  });

  async function download() {
    if (downloading || periodError) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, fileName } = await api.download(path, { query: { ...query, format: "csv" } });
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

  const shown = report === "contracts" ? rows.length : tripRows.length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Laporan"
        figures={
          data.data ? (
            <span>
              <span className="font-semibold text-foreground tabular-nums">{formatNumber(shown)}</span> {report === "contracts" ? "kontrak" : "baris truk"} pada periode ini
            </span>
          ) : null
        }
        description="Realisasi per kontrak dan hasil timbang per truk. CSV berisi semua baris periode yang dipilih."
      >
        <Button variant="outline" onClick={() => void download()} disabled={downloading || Boolean(periodError)}>
          {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          Unduh CSV
        </Button>
      </PageHeader>

      <Segmented<Report>
        label="Jenis laporan"
        value={report}
        onChange={setReport}
        options={[
          { value: "contracts", label: "Per kontrak" },
          { value: "trips", label: "Per truk" },
        ]}
      />

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <TextField label="Dari tanggal" name="from" type="date" value={from} onChange={setFrom} className="w-full sm:w-44" />
        <TextField label="Sampai tanggal" name="to" type="date" value={to} onChange={setTo} error={periodError ?? undefined} className="w-full sm:w-44" />
        <SelectField
          label="Arah"
          name="reportDirection"
          value={direction}
          onChange={setDirection}
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
          onChange={setSearchText}
        />
      </div>

      <div aria-live="polite" className="empty:hidden">
        {downloadError ? <Notice tone="error">CSV belum bisa diunduh. {downloadError}</Notice> : null}
      </div>

      {periodError ? null : data.hasError && !data.data ? (
        <ListError title="Laporan belum bisa dimuat" error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <ListSkeleton label="Memuat laporan" />
      ) : shown === 0 ? (
        <ListEmpty
          title="Tidak ada data pada periode ini"
          hint={report === "trips" ? "Truk masuk laporan setelah timbang pertama." : "Ubah periode, arah, atau pencarian."}
          stale={data.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3" data-testid={`report-${report}`}>
          <ResultCount shown={shown} total={shown} noun={report === "contracts" ? "kontrak" : "baris"} />
          {report === "contracts" ? (
            <DataList columns={CONTRACT_COLUMNS} rows={rows as ContractReportRow[]} rowKey={(row) => row.contractId} stale={data.isStale} />
          ) : (
            <DataList columns={TRIP_COLUMNS} rows={tripRows} rowKey={(row) => `${row.tripId}-${row.seq}`} stale={data.isStale} />
          )}
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
