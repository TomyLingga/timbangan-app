import type { Metadata } from "next";

import { DeliveryOrdersScreen } from "@/features/delivery-orders/delivery-orders-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Delivery Order" };

export default function Page() {
  return <DeliveryOrdersScreen />;
}
