import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { NewRegistrationScreen } from "@/features/registrations/new-registration-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Registrasi baru" };

// The direction and the delivery order come from the address, known only at request time.
export default function Page() {
  return (
    <Suspense fallback={<ListSkeleton label="Menyiapkan form registrasi" />}>
      <NewRegistrationScreen />
    </Suspense>
  );
}
