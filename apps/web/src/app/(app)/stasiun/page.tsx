import type { Metadata } from "next";

import { StationsScreen } from "@/features/stations/stations-screen";

export const metadata: Metadata = { title: "Stasiun" };

export default function StationsPage() {
  return <StationsScreen />;
}
