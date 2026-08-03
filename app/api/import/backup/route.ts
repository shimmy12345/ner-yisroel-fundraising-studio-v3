import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import { ensureUserProfile } from "../../../../lib/auth/profile";

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);

  try {
    const requestUrl = new URL(request.url);
    const purpose = requestUrl.searchParams.get("purpose");
    const importId = requestUrl.searchParams.get("importId")?.trim() || null;
    if ((purpose === "donation_rollback") !== Boolean(importId)) {
      return Response.json({ error: "A rollback backup must identify its import batch." }, { status: 422 });
    }
    if (purpose === "donation_rollback") {
      const ownedImport = await env.DB.prepare("SELECT id FROM data_imports WHERE id = ? AND user_id = ? LIMIT 1").bind(importId, profile.id).first();
      if (!ownedImport) return Response.json({ error: "Import not found" }, { status: 404 });
    }
    const [donors, gifts, givingActivities, interactions, recommendations, activityAudits, dataImports, importChanges, paymentAssignments, refreshState, rollbackAudits] = await Promise.all([
      env.DB.prepare("SELECT * FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample' ORDER BY id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM gifts WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY received_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM giving_activities WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY activity_date, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM interactions WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY occurred_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM recommendations WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY created_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM activity_status_audits WHERE user_id = ? ORDER BY created_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM data_imports WHERE user_id = ? ORDER BY created_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM giving_activity_import_changes WHERE import_id IN (SELECT id FROM data_imports WHERE user_id = ?) ORDER BY import_id, source_fingerprint").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM jl_payment_assignments WHERE user_id = ? ORDER BY created_at, payment_fingerprint").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM jl_refresh_state WHERE user_id = ?").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM donation_import_rollback_audits WHERE user_id = ? ORDER BY created_at, id").bind(profile.id).all(),
    ]);
    const backupId = crypto.randomUUID();
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      format: "fundraising-os-d1-backup-v1",
      donors: donors.results,
      gifts: gifts.results,
      givingActivities: givingActivities.results,
      interactions: interactions.results,
      remindersAndNextActions: recommendations.results,
      activityStatusAudits: activityAudits.results,
      dataImports: dataImports.results,
      givingActivityImportChanges: importChanges.results,
      paymentAssignments: paymentAssignments.results,
      refreshState: refreshState.results,
      rollbackAudits: rollbackAudits.results,
    }, null, 2);
    if (purpose === "donation_rollback") {
      await env.DB.prepare("INSERT INTO workspace_backup_audits (id,user_id,purpose,import_id,created_at) VALUES (?,?,?,?,?)")
        .bind(backupId, profile.id, purpose, importId, Math.floor(Date.now() / 1000)).run();
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return new Response(payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="fundraising-os-backup-${stamp}.json"`,
        "cache-control": "no-store",
        "x-workspace-backup-id": backupId,
      },
    });
  } catch (error) {
    logger.error("import_backup_failed", error, { userId: profile.id });
    return Response.json({ error: "Backup could not be created" }, { status: 500 });
  }
}
