import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AccessGate } from "@/components/access";
import { ConvexClientProvider } from "@/components/providers";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Errand Line · Family", template: "%s · Errand Line" },
  description: "Live calls, orders and alerts for the Errand Line family.",
  robots: { index: false, follow: false },
  // Never leak the page URL (an old `?key=` link) to other sites.
  referrer: "no-referrer",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#141a17" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <ConvexClientProvider>
          <AccessGate>
            <Shell>{children}</Shell>
          </AccessGate>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
