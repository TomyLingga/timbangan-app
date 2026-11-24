import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";

import { Providers } from "@/components/providers";
import { APP_NAME } from "@/lib/config";
import { SIDEBAR_SCRIPT } from "@/lib/sidebar";
import { THEME_SCRIPT } from "@/lib/theme";

import "./globals.css";

// Display: headings and big readouts. The width axis gives the slightly
// expanded, instrument-label cut used across the app.
const display = Archivo({
  variable: "--font-display-face",
  subsets: ["latin"],
  axes: ["wdth"],
});

// Text: reading and interface.
const text = IBM_Plex_Sans({
  variable: "--font-text",
  subsets: ["latin"],
});

// Mono: plates, contract numbers, SPJ codes, card UIDs, weights. The dotted
// zero keeps 0 and O apart on a plate.
const mono = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: "Registrasi truk timbangan: kontrak, delivery order, dan kedatangan kendaraan.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0f13" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the head scripts set the "dark" class and data-sidebar before React hydrates.
    <html
      lang="id"
      className={`${display.variable} ${text.variable} ${mono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `${THEME_SCRIPT};${SIDEBAR_SCRIPT}` }} />
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
