import type { Metadata } from "next";

import { DestinationsScreen } from "@/features/destinations/destinations-screen";

export const metadata: Metadata = { title: "Tujuan" };

export default function Page() {
  return <DestinationsScreen />;
}
