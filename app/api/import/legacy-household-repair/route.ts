import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { buildLegacyHouseholdRepairAssessment, LEGACY_HOUSEHOLD_BATCH_ID, type LegacyBatchRow, type LegacyCandidateRow } from "../../../../lib/import/legacy-household-repair";

async function assessment(userId: string) {
  const batch = await env.DB.prepare("SELECT id,file_name,status,report_json,created_at,completed_at FROM data_imports WHERE id=? AND user_id=? LIMIT 1").bind(LEGACY_HOUSEHOLD_BATCH_ID, userId).first<LegacyBatchRow>();
  if (!batch) return null;
  let firstRelationshipId: string | null = null;
  try { firstRelationshipId = (JSON.parse(batch.report_json) as { firstRelationshipId?: string | null }).firstRelationshipId ?? null; } catch { /* malformed legacy report stays fail-closed */ }
  const [candidateRows, changes, contactAudits] = await Promise.all([
    env.DB.prepare(`SELECT id,display_name,donor_code,external_id,external_source,owner_user_id,data_source,created_at,updated_at FROM donors
      WHERE owner_user_id=? AND data_source='live' AND (id=? OR created_at=? OR updated_at=?) ORDER BY display_name COLLATE NOCASE`)
      .bind(userId, firstRelationshipId ?? "", batch.completed_at ?? -1, batch.completed_at ?? -1).all<LegacyCandidateRow>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM household_import_changes WHERE import_id=? AND user_id=?").bind(batch.id, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM donor_contact_audits WHERE user_id=? AND created_at BETWEEN ? AND ?").bind(userId, (batch.completed_at ?? 0) - 1, (batch.completed_at ?? 0) + 1).first<{ count: number }>(),
  ]);
  return buildLegacyHouseholdRepairAssessment(batch, candidateRows.results, changes?.count ?? 0, contactAudits?.count ?? 0);
}

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const result = await assessment(profile.id);
  if (!result) return Response.json({ error: "Legacy batch not found for this workspace owner" }, { status: 404 });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

export async function POST() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const result = await assessment(profile.id);
  if (!result) return Response.json({ error: "Legacy batch not found for this workspace owner" }, { status: 404 });
  return Response.json({ error: "Automatic repair is blocked because exact batch attribution and before-values are not provable.", ...result }, { status: 409 });
}
