import { TriangleAlert } from "lucide-react";

import { checkSentence, findingWhere } from "@/lib/status";
import type { Finding } from "@/lib/types";

/** Findings of a registration check, one sentence each, with the truck or contract they are about. */
export function FindingsList({ findings }: { findings: readonly Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((finding, index) => {
        const where = findingWhere(finding);
        return (
          <li key={`${finding.code}-${index}`} className="flex items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {where ? <span className="font-medium">{where}: </span> : null}
              {checkSentence(finding)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
