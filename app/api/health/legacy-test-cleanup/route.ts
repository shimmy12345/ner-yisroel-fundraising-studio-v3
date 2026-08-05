import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { loadDataHealth } from "../../../../lib/data-health/read";
import { LEGACY_TEST_CLEANUP_CONFIRMATION, loadLegacyTestCleanupPreview } from "../../../../lib/data-health/legacy-test-cleanup";
import { logger } from "../../../../lib/logger";

export const dynamic = "force-dynamic";

async function owner() {
  const identity = await getChatGPTUser();
  if (!identity) return null;
  return ensureUserProfile(identity);
}

export async function GET() {
  const profile = await owner();
  if (!profile) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const preview = await loadLegacyTestCleanupPreview(env.DB, profile.id);
    return Response.json(preview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logger.error("legacy_test_cleanup_preview_failed", error, { userId: profile.id });
    return Response.json({ error: "The cleanup preview could not be prepared." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const profile = await owner();
  if (!profile) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null) as { previewToken?: string; confirmation?: string; confirmed?: boolean } | null;
  if (!body?.confirmed || body.confirmation !== LEGACY_TEST_CLEANUP_CONFIRMATION) {
    return Response.json({ error: "Confirm the cleanup with the exact confirmation phrase." }, { status: 422 });
  }

  try {
    const preview = await loadLegacyTestCleanupPreview(env.DB, profile.id);
    if (!body.previewToken || body.previewToken !== preview.previewToken) {
      return Response.json({ error: "The records changed after preview. Review the cleanup again before confirming." }, { status: 409 });
    }
    if (!preview.candidates.length) return Response.json({ error: "No proven legacy test records are available to archive." }, { status: 409 });

    const interactions = preview.candidates.filter((row) => row.recordType === "interaction").map((row) => row.recordId);
    const reminders = preview.candidates.filter((row) => row.recordType === "reminder").map((row) => row.recordId);
    const auditId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const recordsJson = JSON.stringify(preview.candidates);
    const interactionIds = JSON.stringify(interactions);
    const reminderIds = JSON.stringify(reminders);
    const statements = [
      env.DB.prepare(`INSERT INTO legacy_test_cleanup_audits
        (id,user_id,preview_hash,records_json,archived_interactions,archived_reminders,created_at)
        SELECT ?,?,?,?,?,?,? WHERE
          (SELECT COUNT(*) FROM interactions i INNER JOIN donors d ON d.id=i.donor_id
            WHERE i.user_id=? AND d.data_source='sample' AND i.source NOT LIKE 'archived:%')=json_array_length(?)
          AND NOT EXISTS (SELECT 1 FROM json_each(?) e LEFT JOIN interactions i ON i.id=e.value AND i.user_id=?
            LEFT JOIN donors d ON d.id=i.donor_id AND d.data_source='sample'
            WHERE i.id IS NULL OR d.id IS NULL OR i.source LIKE 'archived:%')
          AND (SELECT COUNT(*) FROM recommendations r INNER JOIN donors d ON d.id=r.donor_id
            WHERE r.user_id=? AND d.data_source='sample' AND r.status<>'dismissed')=json_array_length(?)
          AND NOT EXISTS (SELECT 1 FROM json_each(?) e LEFT JOIN recommendations r ON r.id=e.value AND r.user_id=?
            LEFT JOIN donors d ON d.id=r.donor_id AND d.data_source='sample'
            WHERE r.id IS NULL OR d.id IS NULL OR r.status='dismissed')`)
        .bind(auditId, profile.id, preview.previewToken, recordsJson, interactions.length, reminders.length, now,
          profile.id, interactionIds, interactionIds, profile.id, profile.id, reminderIds, reminderIds, profile.id),
      env.DB.prepare(`UPDATE interactions SET source='archived:legacy-test:'||source,updated_at=?
        WHERE user_id=? AND id IN (SELECT value FROM json_each(?))
          AND source NOT LIKE 'archived:%' AND EXISTS (SELECT 1 FROM donors d WHERE d.id=interactions.donor_id AND d.data_source='sample')
          AND EXISTS (SELECT 1 FROM legacy_test_cleanup_audits WHERE id=? AND user_id=?)`)
        .bind(now, profile.id, interactionIds, auditId, profile.id),
      env.DB.prepare(`UPDATE recommendations SET status='dismissed',updated_at=?
        WHERE user_id=? AND id IN (SELECT value FROM json_each(?))
          AND status<>'dismissed' AND EXISTS (SELECT 1 FROM donors d WHERE d.id=recommendations.donor_id AND d.data_source='sample')
          AND EXISTS (SELECT 1 FROM legacy_test_cleanup_audits WHERE id=? AND user_id=?)`)
        .bind(now, profile.id, reminderIds, auditId, profile.id),
    ];
    const results = await env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== interactions.length || results[2]?.meta?.changes !== reminders.length) {
      throw new Error("Cleanup snapshot changed during the guarded transaction");
    }
    const report = await loadDataHealth(profile.id);
    logger.info("legacy_test_orphans_archived", { userId: profile.id, auditId, interactions: interactions.length, reminders: reminders.length });
    return Response.json({ auditId, archived: preview.counts, blocked: preview.blocked, report });
  } catch (error) {
    logger.error("legacy_test_cleanup_failed", error, { userId: profile.id });
    return Response.json({ error: "The cleanup could not be completed. No unproven record was changed." }, { status: 500 });
  }
}
