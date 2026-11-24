import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { DeliveryOrderDetailScreen } from "@/features/delivery-orders/delivery-order-detail";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Rincian DO" };

// The id is known only at request time, so the screen reads it inside Suspense.
export default function Page() {
  return (
    <Suspense fallback={<ListSkeleton label="Memuat DO" />}>
      <DeliveryOrderDetailScreen />
    </Suspense>
  );
}
