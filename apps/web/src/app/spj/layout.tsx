import { AuthGate } from "@/features/auth/auth-gate";

// Print pages need a session but not the menu and header around them.
export default function SpjLayout({ children }: LayoutProps<"/spj">) {
  return <AuthGate bare>{children}</AuthGate>;
}
