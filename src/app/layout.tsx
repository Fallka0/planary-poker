import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Onest } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { WalletProvider } from "@/components/WalletProvider";
import "./globals.css";

const ui = Onest({ variable: "--font-ui", subsets: ["latin"] });
const poster = Big_Shoulders({ variable: "--font-poster", weight: ["700", "800", "900"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Hold'em · Planary Casino",
  description: "Multiplayer no-limit Texas Hold'em with Planary Chips. Six seats, one table. Play money only.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { themeColor: "#2a0915" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${poster.variable}`}>
      <body>
        <AuthProvider>
          <WalletProvider>{children}</WalletProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
