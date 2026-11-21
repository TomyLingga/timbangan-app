"use client";

import { CircleAlert, RefreshCw, SearchX } from "lucide-react";
import { motion } from "motion/react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatNumber, formatPercent, formatQuantity } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { MOTION_BASE, rowDelay } from "@/lib/motion";
import { api } from "@/lib/session";
import { contractStateInfo } from "@/lib/status";
import type { Contract, ContractList as ContractListData, Direction } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rows asked for in one request: the API caps a list at 50 and has no offset. */
const PAGE_LIMIT = 50;

const COLUMNS = ["Nomor kontrak", "Partner", "Barang", "Quantity", "Toleransi", "Sertifikat", "Berlaku sampai", "Status"];

interface ContractListProps {
  direction: Direction;
  search: string;
  includeClosed: boolean;
  /** Changes after a sync, which makes the list load again. */
  reloadToken: number;
  onClearSearch: () => void;
}

function ContractNumber({ contract }: { contract: Contract }) {
  return (
    <>
      <span className="font-medium">{contract.contractNo}</span>
      {contract.customerPoNo ? (
        <span className="block text-xs text-muted-foreground">PO {contract.customerPoNo}</span>
      ) : null}
    </>
  );
}

function ContractTable({ items }: { items: Contract[] }) {
  return (
    <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((column) => (
              <TableHead
                key={column}
                scope="col"
                className={cn(
                  "h-11 px-3 text-xs font-medium text-muted-foreground",
                  (column === "Quantity" || column === "Toleransi") && "text-right",
                )}
              >
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((contract, index) => (
            <motion.tr
              key={contract.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: MOTION_BASE, delay: rowDelay(index) }}
              className="border-b transition-colors last:border-0 hover:bg-muted/50"
            >
              <TableCell className="px-3 py-2.5">
                <ContractNumber contract={contract} />
              </TableCell>
              <TableCell className="max-w-56 truncate px-3 py-2.5" title={contract.partner.name}>
                {contract.partner.name}
              </TableCell>
              <TableCell className="max-w-48 truncate px-3 py-2.5" title={contract.product.name}>
                {contract.product.name}
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right tabular-nums">
                {formatQuantity(contract.qtyContract, contract.uom)}
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right tabular-nums">{formatPercent(contract.tolerancePct)}</TableCell>
              <TableCell className="px-3 py-2.5">{contract.certificate || "-"}</TableCell>
              <TableCell className="px-3 py-2.5 tabular-nums">{formatDate(contract.validUntil)}</TableCell>
              <TableCell className="px-3 py-2.5">
                <StatusBadge info={contractStateInfo(contract.state)} />
              </TableCell>
            </motion.tr>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ContractCards({ items }: { items: Contract[] }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {items.map((contract, index) => (
        <motion.li
          key={contract.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOTION_BASE, delay: rowDelay(index) }}
          className="rounded-lg border bg-card p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-sm wrap-break-word">
              <ContractNumber contract={contract} />
            </p>
            <StatusBadge info={contractStateInfo(contract.state)} />
          </div>
          <p className="mt-1 text-sm wrap-break-word text-muted-foreground">{contract.partner.name}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-sm">
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Barang</dt>
              <dd className="wrap-break-word">{contract.product.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Quantity</dt>
              <dd className="tabular-nums">{formatQuantity(contract.qtyContract, contract.uom)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Toleransi</dt>
              <dd className="tabular-nums">{formatPercent(contract.tolerancePct)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Sertifikat</dt>
              <dd>{contract.certificate || "-"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Berlaku sampai</dt>
              <dd className="tabular-nums">{formatDate(contract.validUntil)}</dd>
            </div>
          </dl>
        </motion.li>
      ))}
    </ul>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Memuat daftar kontrak
      </span>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <div className="flex h-11 items-center border-b px-3">
          <Skeleton className="h-3 w-1/3" />
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} className="flex h-[53px] items-center gap-6 border-b px-3 last:border-0">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: 3 }, (_, card) => (
          <div key={card} className="rounded-lg border bg-card p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-4 w-32" />
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-3 h-4 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ContractList({ direction, search, includeClosed, reloadToken, onClearSearch }: ContractListProps) {
  const query = useApiQuery(
    `${direction}|${search}|${includeClosed}|${reloadToken}`,
    (signal) =>
      api.request<ContractListData>("/api/contracts", {
        query: { direction, q: search, limit: PAGE_LIMIT, includeClosed },
        signal,
      }),
    { keepPrevious: true },
  );

  if (query.hasError) {
    return (
      <div className="flex flex-col items-center rounded-lg border bg-card px-4 py-10 text-center">
        <CircleAlert className="size-6 text-destructive" aria-hidden="true" />
        <h2 className="mt-3 text-sm font-semibold">Daftar kontrak belum bisa dimuat</h2>
        <p role="alert" className="mt-1 max-w-md text-sm text-muted-foreground">
          {errorMessage(query.error)}
        </p>
        <Button variant="secondary" className="mt-4" onClick={query.reload}>
          <RefreshCw aria-hidden="true" />
          Coba lagi
        </Button>
      </div>
    );
  }

  if (!query.data) return <ListSkeleton />;

  const { items, total } = query.data;

  if (items.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center rounded-lg border bg-card px-4 py-10 text-center transition-opacity duration-150",
          query.isStale && "opacity-60",
        )}
      >
        <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-3 text-sm font-semibold">Tidak ada kontrak yang cocok</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {search
            ? "Periksa lagi nomor kontrak atau nama partner yang dicari."
            : includeClosed
              ? "Belum ada kontrak untuk arah ini."
              : "Kontrak yang sudah tutup tidak ikut ditampilkan."}
        </p>
        {search ? (
          <Button variant="outline" className="mt-4" onClick={onClearSearch}>
            Hapus pencarian
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div aria-busy={query.isStale} className={cn("transition-opacity duration-150", query.isStale && "opacity-60")}>
      <p role="status" className="mb-3 text-sm text-muted-foreground">
        {total > items.length
          ? `Menampilkan ${formatNumber(items.length)} dari ${formatNumber(total)} kontrak. Persempit pencarian untuk melihat yang lain.`
          : `${formatNumber(items.length)} kontrak`}
      </p>
      <ContractTable items={items} />
      <ContractCards items={items} />
    </div>
  );
}
