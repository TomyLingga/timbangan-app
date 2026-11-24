"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MOTION_BASE, rowDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "right";
  /** Heading of the card on phones. One column should have it. */
  primary?: boolean;
  /** Takes the full card width on phones (long text such as an address). */
  wide?: boolean;
  /** Extra classes for the table cell, for example a width limit. */
  cellClassName?: string;
}

interface DataListProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  /** Buttons for one row. Rendered in a last table column and on top of the card. */
  actions?: (row: T) => ReactNode;
  /** The rows belong to an earlier request; dim them while the new one loads. */
  stale?: boolean;
  /**
   * Opens a row with a pointer click anywhere on it. The row must also hold a button that does the same, since a
   * table row cannot take the keyboard focus.
   */
  onRowClick?: (row: T) => void;
}

/** One column definition, two layouts: a table from 768 px up, cards below. */
export function DataList<T>({ columns, rows, rowKey, actions, stale = false, onRowClick }: DataListProps<T>) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const details = columns.filter((column) => column !== primary);

  return (
    <div aria-busy={stale} className={cn("transition-opacity duration-150", stale && "opacity-60")}>
      <div className="hidden overflow-hidden rounded-2xl border bg-card shadow-panel md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  scope="col"
                  className={cn("h-10 px-3", column.align === "right" && "text-right")}
                >
                  {column.header}
                </TableHead>
              ))}
              {actions ? (
                <TableHead scope="col" className="h-10 px-3">
                  <span className="sr-only">Tindakan</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <motion.tr
                key={rowKey(row)}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: MOTION_BASE, delay: rowDelay(index) }}
                className={cn("transition-colors duration-150 hover:bg-muted/60", onRowClick && "cursor-pointer")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      "px-3 py-2.5",
                      column.align === "right" && "text-right tabular-nums",
                      column.cellClassName,
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
                {actions ? <TableCell className="px-3 py-1.5 text-right">{actions(row)}</TableCell> : null}
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2.5 md:hidden">
        {rows.map((row, index) => (
          <motion.li
            key={rowKey(row)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: MOTION_BASE, delay: rowDelay(index) }}
            className={cn("rounded-2xl border bg-card p-4 shadow-panel", onRowClick && "cursor-pointer")}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-[0.9375rem] wrap-break-word">{primary.cell(row)}</div>
              {actions ? <div className="-mt-1.5 -mr-1.5 shrink-0">{actions(row)}</div> : null}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-dashed pt-3 text-sm">
              {details.map((column) => (
                <div key={column.id} className={cn("min-w-0", column.wide && "col-span-2")}>
                  <dt className="text-xs text-muted-foreground">{column.header}</dt>
                  <dd className={cn("mt-0.5 wrap-break-word", column.align === "right" && "tabular-nums")}>{column.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
