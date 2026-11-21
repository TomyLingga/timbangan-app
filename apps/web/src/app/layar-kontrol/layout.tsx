import { AuthGate } from "@/features/auth/auth-gate";

// The wall screen of the control room needs a session but not the menu and header around it.
// Pages behind the sign-in render in the browser only, so Next.js cannot prerender a shell to validate.
export const instant = false;

export default function WallScreenLayout({ children }: LayoutProps<"/layar-kontrol">) {
  return <AuthGate bare>{children}</AuthGate>;
}
