import { AuthGate } from "@/features/auth/auth-gate";

// Pages behind the sign-in render in the browser only, so Next.js cannot prerender a shell to validate.
export const instant = false;

export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AuthGate>{children}</AuthGate>;
}
