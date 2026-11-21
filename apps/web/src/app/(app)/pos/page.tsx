import type { Metadata } from "next";

import { GateScreen } from "@/features/gate/gate-screen";

export const metadata: Metadata = { title: "Pos registrasi" };

export default function Page() {
  return <GateScreen />;
}
