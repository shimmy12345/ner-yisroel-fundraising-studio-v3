import { redirect } from "next/navigation";

// Monday.com historical-context import now lives in the Import Center
// alongside the JL household/donation imports, not tucked away under
// Settings where it was easy to forget existed. This route stays only so
// an existing bookmark or link still lands somewhere real.
export const dynamic = "force-dynamic";
export default function MondayImportRedirect() {
  redirect("/onboarding/import/monday");
}
