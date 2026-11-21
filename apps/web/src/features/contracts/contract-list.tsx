"use client";

import { motion } from "motion/react";

import { ListEmpty, ListError, ListSkeleton, ResultCount } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate, formatPercent, formatQuantity } from "@/lib/format";
import { MOTION_BASE, rowDelay } from "@/lib/motion";
import { api } from "@/lib/session";
import { contractStateInfo } from "@/lib/status";
import type { Contract, ContractList as ContractListData, Direction } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rows asked for in one request: the API caps a list at 50 and has no offset. */
const PAGE_LIMIT = 50;

const COLUMNS: ReadonlyArray<{ label: string; numeric?: boolean }> = [
  { label: "Nomor kontrak" },
  { label: "Partner" },
  { label: "Barang" },
  { label: "Quantity", numeric: true },
  { label: "Toleransi", numeric: true },
  { label: "Sertifikat" },
  { label: "Berlaku sampai" },
  { label: "Status" },
];

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
      <span className="ident font-medium">{contract.contractNo}</span>
      {contract.customerPoNo ? (
        <span className="block text-xs text-muted-foreground">PO {contract.customerPoNo}</span>
      ) : null}
    </>
  );
}

function ContractTable({ items }: { items: Contract[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border bg-card shadow-panel md:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((column) => (
              <TableHead key={column.label} scope="col" className={cn("h-10 px-3", column.numeric && "text-right")}>
                {column.label}
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
              className="group/row transition-colors duration-150 hover:bg-muted/60"
            >
              <TableCell className="relative px-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                />
                <ContractNumber contract={contract} />
              </TableCell>
              <TableCell className="max-w-56 truncate px-3 py-2.5" title={contract.partner.name}>
                {contract.partner.name}
              </TableCell>
              <TableCell className="max-w-48 truncate px-3 py-2.5 text-muted-foreground" title={contract.product.name}>
                {contract.product.name}
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-[0.8125rem] font-medium">
                {formatQuantity(contract.qtyContract, contract.uom)}
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-[0.8125rem]">{formatPercent(contract.tolerancePct)}</TableCell>
              <TableCell className="px-3 py-2.5 text-muted-foreground">{contract.certificate || "-"}</TableCell>
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
    <ul className="flex flex-col gap-2.5 md:hidden">
      {items.map((contract, index) => (
        <motion.li
          key={contract.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOTION_BASE, delay: rowDelay(index) }}
          className="rounded-2xl border bg-card p-4 shadow-panel"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-[0.9375rem] wrap-break-word">
              <ContractNumber contract={contract} />
            </p>
            <StatusBadge info={contractStateInfo(contract.state)} />
          </div>
          <p className="mt-1 text-sm wrap-break-word">{contract.partner.name}</p>
          <p className="text-sm wrap-break-word text-muted-foreground">{contract.product.name}</p>
          <div className="mt-3 flex items-end justify-between gap-3 border-t border-dashed pt-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Quantity</p>
              <p className="font-mono text-lg leading-tight font-semibold">{formatQuantity(contract.qtyContract, contract.uom)}</p>
            </div>
            <p className="shrink-0 text-right text-xs text-muted-foreground">
              Toleransi <span className="font-mono text-foreground">{formatPercent(contract.tolerancePct)}</span>
            </p>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
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
    return <ListError title="Daftar kontrak belum bisa dimuat" error={query.error} onRetry={query.reload} />;
  }

  if (!query.data) return <ListSkeleton label="Memuat daftar kontrak" />;

  const { items, total } = query.data;

  if (items.length === 0) {
    return (
      <ListEmpty
        title="Tidak ada kontrak yang cocok"
        hint={
          search
            ? "Periksa lagi nomor kontrak atau nama partner yang dicari."
            : includeClosed
              ? "Belum ada kontrak untuk arah ini."
              : "Kontrak yang sudah tutup tidak ikut ditampilkan."
        }
        stale={query.isStale}
      >
        {search ? (
          <Button variant="outline" onClick={onClearSearch}>
            Hapus pencarian
          </Button>
        ) : null}
      </ListEmpty>
    );
  }

  return (
    <div aria-busy={query.isStale} className={cn("flex flex-col gap-3 transition-opacity duration-150", query.isStale && "opacity-60")}>
      <ResultCount shown={items.length} total={total} noun="kontrak" />
      <ContractTable items={items} />
      <ContractCards items={items} />
    </div>
  );
}
