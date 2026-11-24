import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { ApprovalsScreen } from "@/features/approvals/approvals-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Keputusan" };

// The open request (`?permintaan=`) is read from the address bar, so the screen sits inside Suspense.
export default function ApprovalsPage() {
  return (
    <Suspense fallback={<ListSkeleton label="Memuat daftar permintaan" />}>
      <ApprovalsScreen />
    </Suspense>
  );
}
