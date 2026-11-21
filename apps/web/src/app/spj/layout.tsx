import { AuthGate } from "@/features/auth/auth-gate";

// Print pages need a session but not the menu and header around them.
// Pages behind the sign-in render in the browser only, so Next.js cannot prerender a shell to validate.
export const instant = false;

export default function SpjLayout({ children }: LayoutProps<"/spj">) {
  return <AuthGate bare>{children}</AuthGate>;
}
