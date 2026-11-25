import { Suspense } from "react";
import type { Metadata } from "next";

import { ReportPrintScreen } from "@/features/approvals/report-print-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Cetak Berita Acara" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ReportPrintScreen />
    </Suspense>
  );
}
