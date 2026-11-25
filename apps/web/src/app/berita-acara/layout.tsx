import { AuthGate } from "@/features/auth/auth-gate";

// The print page of a Berita Acara needs a session but not the menu and header around it.
// Pages behind the sign-in render in the browser only, so Next.js cannot prerender a shell to validate.
export const instant = false;

export default function BeritaAcaraLayout({ children }: LayoutProps<"/berita-acara">) {
  return <AuthGate bare>{children}</AuthGate>;
}
