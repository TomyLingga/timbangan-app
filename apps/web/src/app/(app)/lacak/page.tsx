import { Suspense } from "react";
import type { Metadata } from "next";

import { TrackingScreen } from "@/features/tracking/tracking-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Lacak kendaraan" };

// The selected truck comes from the query string (?vehicle=, ?trip=), read inside Suspense.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <TrackingScreen />
    </Suspense>
  );
}
