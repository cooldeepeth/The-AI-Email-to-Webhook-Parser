import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "thook — dashboard",
  description: "AI inbound email-to-webhook parser",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
