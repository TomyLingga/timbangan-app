import type { Metadata } from "next";

import { VehiclesScreen } from "@/features/vehicles/vehicles-screen";

export const metadata: Metadata = { title: "Kendaraan" };

export default function Page() {
  return <VehiclesScreen />;
}
