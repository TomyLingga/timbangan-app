import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { NewRegistrationScreen } from "@/features/registrations/new-registration-screen";

export const metadata: Metadata = { title: "Registrasi baru" };

// The direction and the delivery order come from the address, known only at request time.
export default function Page() {
  return (
    <Suspense fallback={<ListSkeleton label="Menyiapkan form registrasi" />}>
      <NewRegistrationScreen />
    </Suspense>
  );
}
