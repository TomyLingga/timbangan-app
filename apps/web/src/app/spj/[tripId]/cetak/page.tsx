import { Suspense } from "react";
import type { Metadata } from "next";

import { SpjPrintScreen } from "@/features/spj/spj-print-screen";

export const metadata: Metadata = { title: "Cetak SPJ" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SpjPrintScreen />
    </Suspense>
  );
}
