import type { Metadata } from "next";

import { TanksScreen } from "@/features/plant-masters/tanks-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Tangki" };

export default function Page() {
  return <TanksScreen />;
}
