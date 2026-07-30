import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(host ? `${protocol}://${host}` : "https://fundraising-os.openai.site");
  const title = "Fundraising OS";
  const description =
    "An AI-powered workspace that helps fundraisers focus on the relationships that matter most.";

  return {
    metadataBase,
    title: { default: title, template: "%s · Fundraising OS" },
    description,
    openGraph: {
      title,
      description: "Know who needs you today.",
      images: [{ url: "/og.png", width: 1732, height: 909, alt: "Fundraising OS — Know who needs you today." }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: "Know who needs you today.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
