import { AuthGate } from "@/features/auth/auth-gate";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AuthGate>{children}</AuthGate>;
}
