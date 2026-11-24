"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { lastPage, pageRangeText, REPORT_PAGE_SIZE } from "@/lib/report-paging";

/** "51–100 dari 4.052 kontrak" with buttons to the previous and next page. */
export function Pager({
  page,
  shown,
  total,
  noun,
  onPage,
  size = REPORT_PAGE_SIZE,
}: {
  page: number;
  /** Rows on this page. */
  shown: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
  size?: number;
}) {
  const last = lastPage(total, size);
  return (
    <nav aria-label="Halaman" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="pager">
      <p role="status" className="text-sm text-muted-foreground tabular-nums">
        {pageRangeText(page, shown, total, size)} {noun}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(Math.min(page - 1, last))}>
          <ChevronLeft aria-hidden="true" />
          Sebelumnya
        </Button>
        <Button variant="outline" size="sm" disabled={page >= last} onClick={() => onPage(page + 1)}>
          Berikutnya
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
