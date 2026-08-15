import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Metropolis (the Clarity Design System face) is self-hosted via @font-face in
// styles/tokens/fonts.css; JetBrains Mono is self-hosted here through next/font.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "QuartzFire",
  description: "QuartzFire firewall management console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} h-full`}>
      <body className="h-full antialiased">
        {children}
        {/* Clarity Icons custom-element runtime (vendored — the appliance is offline). */}
        <Script src="/vendor/clr-icons/clr-icons.min.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
