import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { loadDataHealth } from "../../../lib/data-health/read";

export const dynamic = "force-dynamic";

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const report = await loadDataHealth(profile.id);
  return Response.json(report, {
    status: report.checks.find((check) => check.id === "database")?.status === "critical" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
