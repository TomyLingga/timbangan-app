import type { Metadata } from "next";

import { LoginScreen } from "@/features/auth/login-screen";

export const metadata: Metadata = { title: "Masuk" };

export default function LoginPage() {
  return <LoginScreen />;
}
