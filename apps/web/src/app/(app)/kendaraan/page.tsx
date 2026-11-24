import type { Metadata } from "next";

import { VehiclesScreen } from "@/features/vehicles/vehicles-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Kendaraan" };

export default function Page() {
  return <VehiclesScreen />;
}
