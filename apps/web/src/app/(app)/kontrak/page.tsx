import type { Metadata } from "next";

import { ContractsScreen } from "@/features/contracts/contracts-screen";

export const metadata: Metadata = { title: "Kontrak" };

export default function ContractsPage() {
  return <ContractsScreen />;
}
