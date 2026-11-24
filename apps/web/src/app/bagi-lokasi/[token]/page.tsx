import { Suspense } from "react";
import type { Metadata } from "next";

import { ShareLocationScreen } from "@/features/share-location/share-location-screen";

// Public: the driver opens it from the QR code on the SPJ, without an account and outside the app shell.
export const metadata: Metadata = { title: "Bagikan lokasi" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ShareLocationScreen />
    </Suspense>
  );
}
