import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { logger } from "../../../lib/logger";

const VERIFICATION_CAMPAIGN = "CODEX-VERIFY-49db8e2";
const VERIFICATION_FILES = ["jl-donation-full-verify-49db8e2.csv", "jl-donation-refresh-verify-49db8e2.csv"];
async function isWorkspaceOwner(userId: string) { return Boolean(await env.DB.prepare("SELECT id FROM data_imports WHERE user_id = ? AND status = 'completed' LIMIT 1").bind(userId).first()); }
async function preview(userId: string) {
  const records = await env.DB.prepare(`SELECT COUNT(*) AS records, COUNT(DISTINCT donor_id) AS donors, COUNT(DISTINCT source_fingerprint) AS fingerprints
    FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'verification' AND external_source = 'JL Solutions' AND source_campaign = ?`).bind(userId, VERIFICATION_CAMPAIGN).first<{ records: number; donors: number; fingerprints: number }>();
  const imports = await env.DB.prepare("SELECT COUNT(*) AS count FROM data_imports WHERE user_id = ? AND file_name IN (?, ?)").bind(userId, ...VERIFICATION_FILES).first<{ count: number }>();
  return { records: records?.records ?? 0, donors: records?.donors ?? 0, fingerprints: records?.fingerprints ?? 0, imports: imports?.count ?? 0, marker: VERIFICATION_CAMPAIGN };
}

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  if (!await isWorkspaceOwner(profile.id)) return Response.json({ error: "Only the workspace owner can preview verification cleanup" }, { status: 403 });
  return Response.json({ mode: "preview", ...(await preview(profile.id)), changesMade: false });
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  if (!await isWorkspaceOwner(profile.id)) return Response.json({ error: "Only the workspace owner can remove verification data" }, { status: 403 });
  const body = await request.json().catch(() => null) as { confirmation?: string; backupConfirmed?: boolean } | null;
  if (body?.confirmation !== "REMOVE VERIFICATION DATA" || body.backupConfirmed !== true) return Response.json({ error: "Download a backup and enter the confirmation phrase before removal" }, { status: 422 });
  const affected = await preview(profile.id);
  const auditId = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM giving_activity_import_changes WHERE source_fingerprint IN (SELECT source_fingerprint FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'verification' AND external_source = 'JL Solutions' AND source_campaign = ?)` ).bind(profile.id, VERIFICATION_CAMPAIGN),
      env.DB.prepare("DELETE FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'verification' AND external_source = 'JL Solutions' AND source_campaign = ?").bind(profile.id, VERIFICATION_CAMPAIGN),
      env.DB.prepare("DELETE FROM data_imports WHERE user_id = ? AND file_name IN (?, ?)").bind(profile.id, ...VERIFICATION_FILES),
      env.DB.prepare("INSERT INTO sample_cleanup_audits (id, user_id, backup_confirmed, removed_donors, removed_gifts, removed_interactions, removed_recommendations, created_at) VALUES (?, ?, 1, 0, ?, 0, 0, ?)").bind(auditId, profile.id, affected.records, now),
    ]);
    logger.info("verification_data_removed", { userId: profile.id, auditId, records: affected.records, donors: affected.donors, imports: affected.imports });
    return Response.json({ ...affected, changesMade: true, auditId });
  } catch (error) {
    logger.error("verification_data_cleanup_failed", error, { userId: profile.id });
    return Response.json({ error: "Verification cleanup failed; no partial cleanup was kept" }, { status: 500 });
  }
}
