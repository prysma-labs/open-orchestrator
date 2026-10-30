import type { Metadata } from "next";
import { Fredoka, Hi_Melody, Inter } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

const fredoka = Fredoka({ subsets: ["latin"], variable: "--font-sans" });
const inter = Inter({ subsets: ["latin"], variable: "--font-chat" });
const hiMelody = Hi_Melody({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-wordmark",
});

export const metadata: Metadata = {
  title: "twosigma",
  description: "Shared research chats",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full font-sans",
        fredoka.variable,
        inter.variable,
        hiMelody.variable,
      )}
    >
      <body className="h-full overflow-hidden">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
