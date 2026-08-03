import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { logger } from "../../../../lib/logger";
import { buildHouseholdRollbackPreview, HOUSEHOLD_SNAPSHOT_FIELDS, type CurrentHouseholdRow, type HouseholdChangeRow } from "../../../../lib/import/household-rollback";

type ImportRow = { id: string; file_name: string; status: string; report_json: string; completed_at: number | null };
const isHousehold = (json: string) => { try { const report = JSON.parse(json) as { profile?: string; refresh?: { kind?: string } }; return report.profile !== "JL Solutions Donations" && (report.refresh?.kind === "household" || report.profile === "JL Solutions" || report.profile === "General spreadsheet"); } catch { return false; } };
const isJlHousehold = (json: string) => { try { return (JSON.parse(json) as { profile?: string }).profile === "JL Solutions"; } catch { return false; } };

async function loadPreview(importId: string, userId: string) {
  const dataImport = await env.DB.prepare("SELECT id,file_name,status,report_json,completed_at FROM data_imports WHERE id=? AND user_id=? LIMIT 1").bind(importId, userId).first<ImportRow>();
  if (!dataImport) return { response: Response.json({ error: "Import not found" }, { status: 404 }) };
  if (dataImport.status !== "completed" || !isHousehold(dataImport.report_json)) return { response: Response.json({ error: "This household import is not available for undo." }, { status: 409 }) };
  const completed = await env.DB.prepare("SELECT id,report_json FROM data_imports WHERE user_id=? AND status='completed' ORDER BY completed_at DESC,created_at DESC").bind(userId).all<{ id: string; report_json: string }>();
  if (completed.results.find((row) => isHousehold(row.report_json))?.id !== importId) return { response: Response.json({ error: "Only the most recent completed household import can be reversed." }, { status: 409 }) };
  const priorAudit = await env.DB.prepare("SELECT id FROM household_import_rollback_audits WHERE import_id=? AND user_id=? LIMIT 1").bind(importId, userId).first();
  if (priorAudit) return { response: Response.json({ error: "This household import has already been reversed." }, { status: 409 }) };
  const changes = await env.DB.prepare("SELECT donor_id,change_type,before_json,after_json FROM household_import_changes WHERE import_id=? AND user_id=? ORDER BY created_at,id").bind(importId, userId).all<HouseholdChangeRow>();
  if (!changes.results.length) {
    return { dataImport, restoreJlRefresh: isJlHousehold(dataImport.report_json), previousRefreshAt: null, preview: { safe: false, blockers: ["This older batch cannot be undone because its exact before-values and inserted-record IDs were not recorded."], created: [], recreates: [], restores: [], batchDeletes: { gifts: [], interactions: [], recommendations: [] }, totals: { householdsRemoved: 0, householdsRecreated: 0, householdsRestored: 0, laterEditsPreserved: 0, batchRecordsRemoved: 0 } } };
  }
  const donorIds = changes.results.map((change) => change.donor_id);
  const columns = HOUSEHOLD_SNAPSHOT_FIELDS.map((field) => `d.${field}`).join(",");
  const current = await env.DB.prepare(`SELECT d.id,${columns},
    ((SELECT COUNT(*) FROM gifts g WHERE g.donor_id=d.id) + (SELECT COUNT(*) FROM giving_activities ga WHERE ga.donor_id=d.id) +
     (SELECT COUNT(*) FROM interactions i WHERE i.donor_id=d.id) + (SELECT COUNT(*) FROM recommendations r WHERE r.donor_id=d.id) +
     (SELECT COUNT(*) FROM donor_contact_audits a WHERE a.donor_id=d.id AND a.created_at >= ?)) AS dependency_count
    FROM donors d WHERE d.owner_user_id=? AND d.data_source='live' AND d.id IN (SELECT value FROM json_each(?))`).bind(dataImport.completed_at ?? 0, userId, JSON.stringify(donorIds)).all<CurrentHouseholdRow>();
  const preview = buildHouseholdRollbackPreview(changes.results, current.results);
  let previousRefreshAt: number | null = null;
  try { previousRefreshAt = (JSON.parse(dataImport.report_json) as { household?: { previousRefreshAt?: number | null } }).household?.previousRefreshAt ?? null; } catch { /* null is safe */ }
  return { dataImport, restoreJlRefresh: isJlHousehold(dataImport.report_json), previousRefreshAt, preview };
}

export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const importId = new URL(request.url).searchParams.get("importId")?.trim() ?? "";
  if (!importId) return Response.json({ error: "Import ID is required" }, { status: 422 });
  const userId = (await ensureUserProfile(identity)).id;
  const result = await loadPreview(importId, userId);
  if (result.response) return result.response;
  return Response.json({ importId, fileName: result.dataImport!.file_name, completedAt: result.dataImport!.completed_at, ...result.preview });
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { importId?: string; backupConfirmed?: boolean; backupId?: string; confirmation?: string };
  const importId = body.importId?.trim() ?? "";
  if (!importId || !body.backupConfirmed || !body.backupId || body.confirmation !== "UNDO") return Response.json({ error: "Download the backup and type UNDO before reversing this household batch." }, { status: 422 });
  const userId = (await ensureUserProfile(identity)).id;
  const receipt = await env.DB.prepare("SELECT id FROM workspace_backup_audits WHERE id=? AND user_id=? AND import_id=? AND purpose='household_rollback' LIMIT 1").bind(body.backupId, userId, importId).first();
  if (!receipt) return Response.json({ error: "The backup receipt is invalid. Download a fresh backup and try again." }, { status: 409 });
  const result = await loadPreview(importId, userId);
  if (result.response) return result.response;
  if (!result.preview!.safe) return Response.json({ error: "This household import cannot be safely reversed.", blockers: result.preview!.blockers }, { status: 409 });
  const now = Math.floor(Date.now() / 1000);
  const statements = result.preview!.restores.filter((item) => Object.keys(item.fields).length).map((item) => {
    const entries = Object.entries(item.fields);
    return env.DB.prepare(`UPDATE donors SET ${entries.map(([field]) => `${field}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live'`).bind(...entries.map(([, value]) => value), now, item.donorId, userId);
  });
  const batchDeletes = result.preview!.batchDeletes;
  if (batchDeletes.gifts.length) statements.push(env.DB.prepare("DELETE FROM gifts WHERE id IN (SELECT value FROM json_each(?)) AND donor_id IN (SELECT id FROM donors WHERE owner_user_id=? AND data_source='live')").bind(JSON.stringify(batchDeletes.gifts), userId));
  if (batchDeletes.interactions.length) statements.push(env.DB.prepare("DELETE FROM interactions WHERE id IN (SELECT value FROM json_each(?)) AND user_id=?").bind(JSON.stringify(batchDeletes.interactions), userId));
  if (batchDeletes.recommendations.length) statements.push(env.DB.prepare("DELETE FROM recommendations WHERE id IN (SELECT value FROM json_each(?)) AND user_id=?").bind(JSON.stringify(batchDeletes.recommendations), userId));
  for (const donor of result.preview!.created) statements.push(env.DB.prepare("DELETE FROM donors WHERE id=? AND owner_user_id=? AND data_source='live'").bind(donor.donorId, userId));
  const recreateFields = [...HOUSEHOLD_SNAPSHOT_FIELDS, "created_at", "updated_at"].filter((field) => !["owner_user_id", "data_source"].includes(field));
  const linkTables = ["gifts", "giving_activities", "interactions", "recommendations", "jl_payment_assignment_audits", "donor_contact_audits"] as const;
  for (const donor of result.preview!.recreates) {
    statements.push(env.DB.prepare(`INSERT INTO donors (id,owner_user_id,data_source,${recreateFields.join(",")}) VALUES (?,?,'live',${recreateFields.map(() => "?").join(",")})`).bind(donor.donorId, userId, ...recreateFields.map((field) => donor.snapshot[field] ?? null)));
    for (const table of linkTables) {
      const ids = donor.linked[table] ?? [];
      if (ids.length) statements.push(env.DB.prepare(`UPDATE ${table} SET donor_id=? WHERE donor_id=? AND id IN (SELECT value FROM json_each(?))`).bind(donor.donorId, donor.mergedInto, JSON.stringify(ids)));
    }
  }
  const auditId = crypto.randomUUID();
  statements.push(env.DB.prepare("UPDATE data_imports SET status='undone' WHERE id=? AND user_id=? AND status='completed'").bind(importId, userId));
  if (result.restoreJlRefresh) statements.push(env.DB.prepare("UPDATE jl_refresh_state SET last_household_refresh_at=?,updated_at=? WHERE user_id=?").bind(result.previousRefreshAt, now, userId));
  statements.push(
    env.DB.prepare("INSERT INTO household_import_rollback_audits (id,user_id,import_id,backup_confirmed,preview_json,removed_donors,restored_donors,preserved_later_edits,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(auditId, userId, importId, 1, JSON.stringify(result.preview), result.preview!.totals.householdsRemoved, result.preview!.totals.householdsRestored + result.preview!.totals.householdsRecreated, result.preview!.totals.laterEditsPreserved, now),
  );
  try {
    await env.DB.batch(statements);
    logger.info("household_import_rolled_back", { importId, userId, auditId, removed: result.preview!.totals.householdsRemoved, restored: result.preview!.totals.householdsRestored });
    return Response.json({ importId, auditId, status: "undone", ...result.preview!.totals });
  } catch {
    logger.error("household_rollback_failed", new Error("Database transaction failed"), { importId, userId });
    return Response.json({ error: "Rollback failed. No partial household rollback was retained." }, { status: 500 });
  }
}
