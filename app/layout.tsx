import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trezad — SMS & Email Marketing",
  description: "Manage contacts, create SMS, WhatsApp and HTML email campaigns, and control delivery in your private Trezad workspace.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
