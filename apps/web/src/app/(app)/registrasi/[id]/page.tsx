import { Suspense } from "react";
import type { Metadata } from "next";

import { ListSkeleton } from "@/components/page-parts";
import { RegistrationDetailScreen } from "@/features/registrations/registration-detail";

export const metadata: Metadata = { title: "Rincian registrasi" };

// The id is known only at request time, so the screen reads it inside Suspense.
export default function Page() {
  return (
    <Suspense fallback={<ListSkeleton label="Memuat registrasi" />}>
      <RegistrationDetailScreen />
    </Suspense>
  );
}
