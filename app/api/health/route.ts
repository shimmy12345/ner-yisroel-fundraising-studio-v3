import { getChatGPTUser } from "../../chatgpt-auth";
import { userIdForEmail } from "../../../lib/auth/profile";
import { loadDataHealth } from "../../../lib/data-health/read";

export const dynamic = "force-dynamic";

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  // Health checks stay read-only so verifying a fresh production database
  // cannot create its first business record.
  const report = await loadDataHealth(userIdForEmail(identity.email));
  return Response.json(report, {
    status: report.checks.find((check) => check.id === "database")?.status === "critical" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
