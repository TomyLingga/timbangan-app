import type { Metadata } from "next";

import { DriversScreen } from "@/features/drivers/drivers-screen";

export const metadata: Metadata = { title: "Supir" };

export default function Page() {
  return <DriversScreen />;
}
