import type { Metadata } from "next";

import { SealsScreen } from "@/features/plant-masters/seals-screen";

export const metadata: Metadata = { title: "Segel" };

export default function Page() {
  return <SealsScreen />;
}
