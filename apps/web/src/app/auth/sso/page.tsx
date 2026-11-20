import { Suspense } from "react";
import type { Metadata } from "next";

import { LoadingScreen } from "@/components/status-screen";
import { SsoCallback } from "@/features/auth/sso-callback";

export const metadata: Metadata = {
  title: "Masuk lewat Portal INL",
  // The URL of this page carries a one-time token; never pass it on as a referrer.
  referrer: "no-referrer",
};

export default function SsoPage() {
  return (
    // useSearchParams needs a Suspense boundary; the fallback is what gets prerendered.
    <Suspense fallback={<LoadingScreen label="Memeriksa tiket masuk dari Portal INL" />}>
      <SsoCallback />
    </Suspense>
  );
}
