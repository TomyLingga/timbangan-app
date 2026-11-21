import { AuthGate } from "@/features/auth/auth-gate";

// The wall screen of the control room needs a session but not the menu and header around it.
export default function WallScreenLayout({ children }: LayoutProps<"/layar-kontrol">) {
  return <AuthGate bare>{children}</AuthGate>;
}
