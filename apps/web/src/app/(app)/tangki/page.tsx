import type { Metadata } from "next";

import { TanksScreen } from "@/features/plant-masters/tanks-screen";

export const metadata: Metadata = { title: "Tangki" };

export default function Page() {
  return <TanksScreen />;
}
