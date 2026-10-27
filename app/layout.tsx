import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Orchestrator",
  description: "A shared workspace where scout, implementer, and reviewer agents work in the open.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
