"use client";

import { useId, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField, TextField } from "@/components/form-fields";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, SearchField } from "@/components/page-parts";
import { Pager } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { useAuth } from "@/features/auth/auth-provider";
import { HistoryDialog } from "@/features/history/history-dialog";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlParam } from "@/hooks/use-url-filter";
import { formatDate, formatNumber, PLANT_TIME_ZONE } from "@/lib/format";
import {
  HISTORY_CONTRACT_FILTERS,
  HISTORY_DIRECTIONS,
  HISTORY_SITES,
  HISTORY_STATES,
  historyPeriod,
  historyStateInfo,
  NO_CONTRACT_TITLE,
  withoutContract,
  type LegacyHistoryTotals,
  type LegacyTrip,
} from "@/lib/legacy-history";
import { errorMessage } from "@/lib/messages";
import { canSeeReports } from "@/lib/permissions";
import { pageFromParam, pageOffset, REPORT_PAGE_SIZE } from "@/lib/report-paging";
import { api } from "@/lib/session";
import type { ReportPage } from "@/lib/types";

const plantDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TIME_ZONE }).format(date);
const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);
const DIRECTION_WORDS: Record<string, string> = { IN: "Incoming", OUT: "Outgoing" };

/** Small quiet mark under a cell, explained by its title. */
function QuietMark({ title, children }: { title: string; children: string }) {
  return (
    <span
      className="inline-flex h-5 w-fit items-center rounded-sm border border-dashed border-line-strong px-1.5 text-[0.6875rem] font-medium whitespace-nowrap text-muted-foreground"
      title={title}
    >
      {children}
    </span>
  );
}

/** Small mark of a row that is one contract of a truck carrying several. */
function GroupMark() {
  return <QuietMark title="Satu truk dengan beberapa kontrak. Bruto dan tarra untuk seluruh truk, netto untuk baris ini.">multi kontrak</QuietMark>;
}

/** Small mark of an incoming reference that is not in the Odoo contract list. */
function NoContractMark() {
  return <QuietMark title={NO_CONTRACT_TITLE}>tanpa kontrak</QuietMark>;
}

function columnsFor(open: (row: LegacyTrip) => void): ReadonlyArray<Column<LegacyTrip>> {
  return [
    {
      id: "ticket",
      header: "Tanggal dan tiket",
      primary: true,
      cell: (row) => (
        <span className="flex flex-col items-start gap-0.5">
          <span className="text-sm whitespace-nowrap tabular-nums">{formatDate(row.entryDate)}</span>
          <button
            type="button"
            data-history-open={row.id}
            onClick={(event) => {
              event.stopPropagation();
              open(row);
            }}
            aria-label={`Rincian tiket ${row.ticketNo ?? row.legacyId}${row.plateText ? `, ${row.plateText}` : ""}`}
            className="-mx-1 rounded-sm px-1 font-mono text-xs font-semibold text-primary-ink underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {row.ticketNo ?? `id ${row.legacyId}`}
          </button>
          {row.groupId !== null ? <GroupMark /> : null}
        </span>
      ),
    },
    {
      id: "truck",
      header: "Truk",
      cell: (row) => (
        <span className="flex flex-col gap-1">
          <span className="plate w-fit text-[0.8125rem]">{row.plateText ?? "-"}</span>
          <span className="text-xs text-muted-foreground">{row.driverName ?? "-"}</span>
        </span>
      ),
    },
    {
      id: "partner",
      header: "Partner dan produk",
      cellClassName: "max-w-56 whitespace-normal",
      cell: (row) => (
        <span className="flex flex-col">
          <span className="line-clamp-2">{row.partnerName ?? row.transporter ?? "-"}</span>
          <span className="text-xs text-muted-foreground">{row.productName ?? "-"}</span>
        </span>
      ),
    },
    {
      id: "reference",
      header: "Kontrak atau DO",
      cellClassName: "max-w-56 whitespace-normal",
      cell: (row) => (
        <span className="flex flex-col items-start">
          <span className="ident text-sm break-all">{row.reference ?? row.doNo ?? "-"}</span>
          {withoutContract(row) ? <NoContractMark /> : null}
          <span className="text-xs text-muted-foreground">{DIRECTION_WORDS[row.direction] ?? "Arah tidak tercatat"}</span>
        </span>
      ),
    },
    {
      id: "weights",
      header: "Netto (bruto, tarra)",
      align: "right",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <span className="font-mono font-semibold whitespace-nowrap">{kg(row.netKg)}</span>
          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
            {row.grossKg === null ? "-" : formatNumber(row.grossKg)}, {row.tareKg === null ? "-" : formatNumber(row.tareKg)}
          </span>
        </span>
      ),
    },
    { id: "state", header: "Keadaan", cell: (row) => <StatusBadge info={historyStateInfo(row.state)} /> },
  ];
}

function HistoryPage() {
  const ids = useId();
  const period = historyPeriod(plantDay(new Date()));
  // every filter and the page live in the address bar, so a reload or a shared link shows the same rows
  const [from, setFrom] = useUrlParam("from", period.from);
  const [to, setTo] = useUrlParam("to", period.to);
  const [direction, setDirection] = useUrlParam("direction", "");
  const [state, setState] = useUrlParam("state", "");
  const [site, setSite] = useUrlParam("site", "");
  const [contract, setContract] = useUrlParam("contract", "");
  const [searchText, setSearchText] = useUrlParam("q", "");
  const [pageParam, setPageParam] = useUrlParam("page", "1");
  const search = useDebouncedValue(searchText.trim(), 300);
  const page = pageFromParam(pageParam);
  const [openId, setOpenId] = useState<number | null>(null);
  // the row to give the focus back to; still known after the dialog has closed
  const [lastOpened, setLastOpened] = useState<number | null>(null);
  const openRow = (row: LegacyTrip) => {
    setLastOpened(row.id);
    setOpenId(row.id);
  };
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Any other filter changes the rows, so the list starts again at its first page. */
  const fresh =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPageParam("1");
    };

  const periodError = from && to && from > to ? "Tanggal akhir tidak boleh sebelum tanggal awal." : null;
  const filters = {
    q: search || undefined,
    from: from || undefined,
    to: to || undefined,
    direction: direction || undefined,
    state: state || undefined,
    site: site || undefined,
    contract: contract || undefined,
  };
  const list = useApiQuery(
    periodError ? null : `history|${search}|${from}|${to}|${direction}|${state}|${site}|${contract}|${page}`,
    (signal) =>
      api.request<ReportPage<LegacyTrip, LegacyHistoryTotals>>("/api/history/trips", {
        query: { ...filters, limit: REPORT_PAGE_SIZE, offset: pageOffset(page) },
        signal,
      }),
    { keepPrevious: true },
  );
  const answer = list.data;
  const shown = answer?.items.length ?? 0;
  const total = answer?.total ?? 0;
  const columns = columnsFor(openRow);

  async function download() {
    if (downloading || periodError) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      // the CSV holds every matching row, not only this page
      const { blob, fileName } = await api.download("/api/history/trips", { query: { ...filters, format: "csv" } });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName ?? "riwayat-lama.csv";
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
  const figures = answer ? (
    <>
      <span>{figure(formatNumber(total))} baris</span>
      <span>
        {figure(formatNumber(answer.totals.trucks))} truk, {figure(formatNumber(answer.totals.completedTrucks))} selesai
      </span>
      <span>Netto truk selesai {figure(kg(answer.totals.netKg))}</span>
    </>
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Riwayat lama"
        figures={figures}
        description="Data registrasi dari aplikasi timbangan lama sampai aplikasi ini mulai dipakai. Hanya bisa dibaca."
      >
        <Button variant="outline" onClick={() => void download()} disabled={downloading || Boolean(periodError)}>
          {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          Unduh CSV
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField
          id={`${ids}-search`}
          label="Cari"
          placeholder="Plat, nomor tiket, kontrak, DO, atau supir"
          value={searchText}
          onChange={fresh(setSearchText)}
        />
        <TextField label="Dari tanggal" name="from" type="date" value={from} onChange={fresh(setFrom)} className="w-full sm:w-44" />
        <TextField label="Sampai tanggal" name="to" type="date" value={to} onChange={fresh(setTo)} error={periodError ?? undefined} className="w-full sm:w-44" />
        <SelectField label="Arah" name="historyDirection" value={direction} onChange={fresh(setDirection)} emptyLabel="Semua arah" options={HISTORY_DIRECTIONS} className="w-full sm:w-40" />
        <SelectField label="Keadaan" name="historyState" value={state} onChange={fresh(setState)} emptyLabel="Semua keadaan" options={HISTORY_STATES} className="w-full sm:w-48" />
        <SelectField label="Cabang" name="historySite" value={site} onChange={fresh(setSite)} emptyLabel="Semua cabang" options={HISTORY_SITES} className="w-full sm:w-40" />
        <SelectField
          label="Kontrak"
          name="historyContract"
          value={contract}
          onChange={fresh(setContract)}
          emptyLabel="Semua"
          options={HISTORY_CONTRACT_FILTERS}
          className="w-full sm:w-52"
        />
      </div>

      <div aria-live="polite" className="empty:hidden">
        {downloadError ? <Notice tone="error">CSV belum bisa diunduh. {downloadError}</Notice> : null}
      </div>

      {periodError ? null : list.hasError && !answer ? (
        <ListError title="Riwayat lama belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !answer ? (
        <ListSkeleton label="Memuat riwayat lama" />
      ) : total === 0 ? (
        <ListEmpty title="Tidak ada data yang cocok" hint="Ubah periode, pencarian, atau saringan lain." stale={list.isStale} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="history-list">
          <Pager page={page} shown={shown} total={total} noun="baris" onPage={(next) => setPageParam(String(next))} />
          {shown === 0 ? (
            <ListEmpty title="Halaman ini kosong" hint="Kembali ke halaman sebelumnya." stale={list.isStale} />
          ) : (
            <DataList columns={columns} rows={answer.items} rowKey={(row) => row.id} stale={list.isStale} onRowClick={openRow} />
          )}
          {shown > 10 ? <Pager page={page} shown={shown} total={total} noun="baris" onPage={(next) => setPageParam(String(next))} /> : null}
        </div>
      )}

      <HistoryDialog
        id={openId}
        onClose={() => setOpenId(null)}
        // the table and the phone cards both hold the button; the visible one gets the focus back
        returnFocus={() =>
          [...document.querySelectorAll<HTMLElement>(`[data-history-open="${lastOpened}"]`)].find((button) => button.offsetParent !== null) ?? null
        }
      />
    </div>
  );
}

export function HistoryScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeeReports(state.user)) return <AccessDenied module="reports" />;
  return <HistoryPage />;
}
