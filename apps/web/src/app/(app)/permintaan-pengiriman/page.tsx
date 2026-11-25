import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { ShipmentRequestsScreen } from "@/features/shipment-requests/shipment-requests-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Permintaan pengiriman" };

// The search and status filters live in the address bar, so the screen sits inside Suspense.
export default function Page() {
  return (
    <Suspense fallback={<ListSkeleton label="Memuat daftar permintaan" />}>
      <ShipmentRequestsScreen />
    </Suspense>
  );
}
