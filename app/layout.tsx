import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { env } from "cloudflare:workers";
import { deploymentEnvironment } from "../lib/environment";
import { isStagingWritesOverrideEnabled } from "../lib/operations/staging-write-guard";
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

// Persistent read-only warning for Independent Staging (Production
// Operational Transition, docs/AI-HANDOFF.md) -- rendered on every
// page via the root layout, so no route can be missed. Never renders
// on Production: deploymentEnvironment there is always
// "production-independent", never "staging-independent". When the
// owner has explicitly flipped STAGING_WRITES_ENABLED="true" for a
// testing window, shows a distinct banner instead, so a tester is
// never misled into thinking writes are still blocked server-side.
function StagingBanner() {
  if (deploymentEnvironment !== "staging-independent") return null;
  const writesEnabled = isStagingWritesOverrideEnabled(env.STAGING_WRITES_ENABLED);
  return (
    <div
      role="status"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 9999,
        width: "100%",
        padding: "8px 16px",
        textAlign: "center",
        fontSize: 14,
        fontWeight: 600,
        color: "#fff",
        background: writesEnabled ? "#b45309" : "#991b1b",
      }}
    >
      {writesEnabled
        ? "STAGING — TEMPORARY WRITES ENABLED FOR TESTING. Turn STAGING_WRITES_ENABLED off when finished."
        : "STAGING — READ ONLY, except Trip Planning. All live donor updates and imports must be entered in Production."}
    </div>
  );
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <StagingBanner />
        {children}
      </body>
    </html>
  );
}
