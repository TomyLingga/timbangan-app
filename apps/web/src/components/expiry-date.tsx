import { TriangleAlert } from "lucide-react";

import { formatDate } from "@/lib/format";

/**
 * A validity date. When it has passed, the date turns red and gets an icon and
 * the word "lewat", so the mark does not depend on colour alone.
 */
export function ExpiryDate({ value, expired }: { value: string | null; expired: boolean }) {
  if (!expired) return <span className="tabular-nums">{formatDate(value)}</span>;
  return (
    <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-destructive tabular-nums">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {formatDate(value)}
      <span className="font-normal">(lewat)</span>
    </span>
  );
}
