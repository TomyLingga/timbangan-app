import type { Metadata } from "next";

import { HomeScreen } from "@/features/home/home-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Beranda" };

export default function HomePage() {
  return <HomeScreen />;
}
