import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { logger } from "../../../lib/logger";

async function counts() {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM donors WHERE data_source = 'sample') AS donors,
    (SELECT COUNT(*) FROM gifts WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')) AS gifts,
    (SELECT COUNT(*) FROM giving_activities WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')) AS giving,
    (SELECT COUNT(*) FROM interactions WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')) AS interactions,
    (SELECT COUNT(*) FROM recommendations WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')) AS recommendations`).first<Record<string, number>>();
  return { donors: row?.donors ?? 0, gifts: (row?.gifts ?? 0) + (row?.giving ?? 0), interactions: row?.interactions ?? 0, recommendations: row?.recommendations ?? 0 };
}
async function workspaceOwner(userId: string) { return Boolean(await env.DB.prepare("SELECT id FROM data_imports WHERE user_id = ? AND status = 'completed' LIMIT 1").bind(userId).first()); }

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  if (!await workspaceOwner(profile.id)) return Response.json({ error: "Only the workspace owner can preview sample cleanup" }, { status: 403 });
  return Response.json({ mode: "preview", ...(await counts()), changesMade: false });
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  if (!await workspaceOwner(profile.id)) return Response.json({ error: "Only the workspace owner can remove sample data" }, { status: 403 });
  const body = await request.json().catch(() => null) as { confirmation?: string; backupConfirmed?: boolean } | null;
  if (body?.confirmation !== "REMOVE SAMPLE DATA" || body.backupConfirmed !== true) return Response.json({ error: "Download a backup and enter the confirmation phrase before removal" }, { status: 422 });
  const preview = await counts();
  const now = Math.floor(Date.now() / 1000), auditId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM giving_activity_import_changes WHERE source_fingerprint IN (SELECT source_fingerprint FROM giving_activities WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample'))"),
      env.DB.prepare("DELETE FROM giving_activities WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')"),
      env.DB.prepare("DELETE FROM gifts WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')"),
      env.DB.prepare("DELETE FROM interactions WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')"),
      env.DB.prepare("DELETE FROM recommendations WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')"),
      env.DB.prepare("DELETE FROM donors WHERE data_source = 'sample'"),
      env.DB.prepare("INSERT INTO sample_cleanup_audits (id, user_id, backup_confirmed, removed_donors, removed_gifts, removed_interactions, removed_recommendations, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)").bind(auditId, profile.id, preview.donors, preview.gifts, preview.interactions, preview.recommendations, now),
    ]);
    logger.info("sample_data_removed", { userId: profile.id, auditId, ...preview });
    return Response.json({ ...preview, changesMade: true, auditId });
  } catch (error) {
    logger.error("sample_data_cleanup_failed", error, { userId: profile.id });
    return Response.json({ error: "Sample cleanup failed; no partial cleanup was kept" }, { status: 500 });
  }
}
