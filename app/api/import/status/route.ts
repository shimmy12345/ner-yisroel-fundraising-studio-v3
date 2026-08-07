import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { classifyAttemptOutcome, type ImportAttemptRow } from "../../../../lib/import/import-attempt";

export const dynamic = "force-dynamic";

// Lets the client reconcile a commit whose response was lost (e.g. a bare
// "Failed to fetch") without ever guessing: looks the attemptId up by its
// owner-scoped data_imports row rather than trusting anything the client
// claims about the outcome. Never returns another owner's attempt.
export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const attemptId = new URL(request.url).searchParams.get("attemptId")?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return Response.json({ error: "A valid attemptId is required" }, { status: 422 });

  const attempt = await env.DB.prepare("SELECT id, status, report_json, created_at FROM data_imports WHERE id = ? AND user_id = ?").bind(attemptId, profile.id).first<ImportAttemptRow>();
  const now = Math.floor(Date.now() / 1000);
  const outcome = classifyAttemptOutcome(attempt, now);
  return Response.json({
    attemptId,
    status: outcome,
    report: outcome === "committed" && attempt ? JSON.parse(attempt.report_json) : null,
  }, { headers: { "cache-control": "no-store" } });
}
