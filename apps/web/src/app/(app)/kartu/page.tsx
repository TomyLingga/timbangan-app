import type { Metadata } from "next";

import { CardsScreen } from "@/features/cards/cards-screen";

export const metadata: Metadata = { title: "Kartu RFID" };

export default function Page() {
  return <CardsScreen />;
}
