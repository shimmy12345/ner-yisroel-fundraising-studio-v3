import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { isPreviewSessionUsable, previewSessionExpiresAt, type PreviewSessionRow } from "../../../../lib/import/preview-session";

export const dynamic = "force-dynamic";

// Lists this owner's resumable, unfinished donation review drafts, most
// recently active first. Never another owner's -- scoped by the
// authenticated user's id, not anything client-supplied.
export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const now = Math.floor(Date.now() / 1000);
  const drafts = await env.DB.prepare("SELECT id, file_name, file_hash, row_count, progress_resolved, progress_total, created_at, updated_at, expires_at FROM import_preview_sessions WHERE owner_user_id = ? AND status = 'draft' AND expires_at > ? ORDER BY updated_at DESC LIMIT 20")
    .bind(profile.id, now)
    .all<{ id: string; file_name: string; file_hash: string; row_count: number; progress_resolved: number; progress_total: number; created_at: number; updated_at: number; expires_at: number }>();
  return Response.json({ drafts: drafts.results }, { headers: { "cache-control": "no-store" } });
}

type SaveDecisionsRequest = { previewSessionId?: string; decisions?: Record<string, unknown>; progressResolved?: number; progressTotal?: number };

// Saves review progress incrementally, as the user works through rows --
// not only at final commit. Every save also extends the draft's
// inactivity expiration, so an actively reviewed import never expires
// underneath the user.
export async function PUT(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  let body: SaveDecisionsRequest;
  try { body = await request.json() as SaveDecisionsRequest; } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  const previewSessionId = typeof body.previewSessionId === "string" ? body.previewSessionId.trim() : "";
  if (!previewSessionId || !body.decisions || typeof body.decisions !== "object" || Array.isArray(body.decisions)) {
    return Response.json({ error: "A previewSessionId and decisions object are required" }, { status: 422 });
  }
  const progressResolved = Number.isFinite(body.progressResolved) ? Math.max(0, Math.trunc(body.progressResolved as number)) : 0;
  const progressTotal = Number.isFinite(body.progressTotal) ? Math.max(0, Math.trunc(body.progressTotal as number)) : 0;
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare("SELECT id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, decisions_json, status, progress_resolved, progress_total, created_at, updated_at, expires_at FROM import_preview_sessions WHERE id = ?").bind(previewSessionId).first<PreviewSessionRow>();
  if (!isPreviewSessionUsable(session, profile.id, now)) {
    return Response.json({ error: "This draft has expired or no longer exists.", draftUnavailable: true }, { status: 410 });
  }
  await env.DB.prepare("UPDATE import_preview_sessions SET decisions_json = ?, progress_resolved = ?, progress_total = ?, updated_at = ?, expires_at = ? WHERE id = ?")
    .bind(JSON.stringify(body.decisions), progressResolved, progressTotal, now, previewSessionExpiresAt(now), previewSessionId)
    .run();
  return Response.json({ savedAt: now, expiresAt: previewSessionExpiresAt(now) });
}

// Discards a draft the user no longer wants to resume. Deletes it outright
// (rather than just marking it) since a discarded draft has no audit value
// -- nothing was ever imported from it.
export async function DELETE(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const previewSessionId = new URL(request.url).searchParams.get("previewSessionId")?.trim() ?? "";
  if (!previewSessionId) return Response.json({ error: "A previewSessionId is required" }, { status: 422 });
  const session = await env.DB.prepare("SELECT id, owner_user_id FROM import_preview_sessions WHERE id = ? AND owner_user_id = ?").bind(previewSessionId, profile.id).first<{ id: string; owner_user_id: string }>();
  if (!session) return Response.json({ discarded: true });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_preview_session_chunks WHERE session_id = ?").bind(previewSessionId),
    env.DB.prepare("DELETE FROM import_preview_sessions WHERE id = ?").bind(previewSessionId),
  ]);
  return Response.json({ discarded: true });
}
