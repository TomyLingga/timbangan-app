import type { Metadata } from "next";

import { DeliveryOrdersScreen } from "@/features/delivery-orders/delivery-orders-screen";

export const metadata: Metadata = { title: "Delivery Order" };

export default function Page() {
  return <DeliveryOrdersScreen />;
}
