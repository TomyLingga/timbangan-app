import type { Metadata } from "next";

import { DriversScreen } from "@/features/drivers/drivers-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Supir" };

export default function Page() {
  return <DriversScreen />;
}
