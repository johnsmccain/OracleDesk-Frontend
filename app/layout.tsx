import type { Metadata, Viewport } from "next";
// import { Geist, Geist_Mono, Inter } from "next/font/google";
import Navbar from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { WalletProvider } from "@/lib/contexts/WalletContext";
import "./globals.css";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { HealthProvider } from "@/lib/health/HealthProvider";
import { InboxProvider } from "@/lib/notifications/InboxProvider";
import { PwaRegistrar } from "@/components/pwa/pwa-registrar";
import { DebugMount } from "@/components/debug/debug-mount";
import { RpcDegradedBanner } from "@/components/debug/RpcPanel";
import { AnnouncerProvider } from "@/components/ui/announcer";

const geistSans = {
  variable: "--font-geist-sans",
};

const geistMono = {
  variable: "--font-geist-mono",
};

const inter = {
  variable: "--font-inter",
};

export const metadata: Metadata = {
  title: "OracleDesk | Institutional-Grade AI Prediction Terminal",
  description: "The world's most accurate AI-driven prediction terminal.",
  applicationName: "OracleDesk",
  appleWebApp: { capable: true, title: "OracleDesk", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#004655",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} h-full antialiased`}
    >
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=block"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col font-body-md text-on-surface">
        <PwaRegistrar>
          <WalletProvider>
            <RealtimeProvider>
              <HealthProvider>
                <InboxProvider>
                  <AnnouncerProvider>
                    <Navbar />
                    <RpcDegradedBanner />
                    {children}
                    <Footer />
                    <DebugMount />
                  </AnnouncerProvider>
                </InboxProvider>
              </HealthProvider>
            </RealtimeProvider>
          </WalletProvider>
        </PwaRegistrar>
      </body>
    </html>
  );
}
