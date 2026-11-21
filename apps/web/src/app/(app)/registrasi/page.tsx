import type { Metadata } from "next";

import { RegistrationsScreen } from "@/features/registrations/registrations-screen";

export const metadata: Metadata = { title: "Registrasi" };

export default function Page() {
  return <RegistrationsScreen />;
}
