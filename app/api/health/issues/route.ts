import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { logger } from "../../../../lib/logger";
import { loadDataHealth } from "../../../../lib/data-health/read";
import {
  HEALTH_REPAIR_DONORS_SQL,
  ORPHANED_INTERACTION_DETAILS_SQL,
  ORPHANED_REMINDER_DETAILS_SQL,
  explainOrphan,
  isHealthIssueCheck,
  isHealthRepairAction,
  toHealthIssue,
  type HealthIssueType,
  type OrphanRecordRow,
} from "../../../../lib/data-health/issues";
import type { DonorSearchRecord } from "../../../../lib/relationships/donor-search";

export const dynamic = "force-dynamic";

type CurrentIssueRow = OrphanRecordRow & { source: string | null; status: string | null };
type RepairBody = {
  recordType?: HealthIssueType;
  recordId?: string;
  action?: unknown;
  targetDonorId?: string | null;
  confirmed?: boolean;
};

const currentInteractionSql = `SELECT i.id,i.donor_id,i.occurred_at AS event_at,
  substr(CASE WHEN instr(i.summary,char(10))>0 THEN substr(i.summary,1,instr(i.summary,char(10))-1) ELSE i.summary END,1,240) AS title,i.source,NULL AS status,
  d.id AS linked_donor_id,d.owner_user_id AS donor_owner_user_id,d.data_source AS donor_data_source,
  d.archived_at AS donor_archived_at,d.merged_into_donor_id,
  survivor.id AS survivor_id,survivor.owner_user_id AS survivor_owner_user_id,
  survivor.data_source AS survivor_data_source,survivor.archived_at AS survivor_archived_at
  FROM interactions i LEFT JOIN donors d ON d.id=i.donor_id
  LEFT JOIN donors survivor ON survivor.id=d.merged_into_donor_id
  WHERE i.id=? AND i.user_id=? AND i.source NOT LIKE 'archived:%' LIMIT 1`;

const currentReminderSql = `SELECT r.id,r.donor_id,COALESCE(r.due_at,r.created_at) AS event_at,r.action AS title,NULL AS source,r.status,
  d.id AS linked_donor_id,d.owner_user_id AS donor_owner_user_id,d.data_source AS donor_data_source,
  d.archived_at AS donor_archived_at,d.merged_into_donor_id,
  survivor.id AS survivor_id,survivor.owner_user_id AS survivor_owner_user_id,
  survivor.data_source AS survivor_data_source,survivor.archived_at AS survivor_archived_at
  FROM recommendations r LEFT JOIN donors d ON d.id=r.donor_id
  LEFT JOIN donors survivor ON survivor.id=d.merged_into_donor_id
  WHERE r.id=? AND r.user_id=? AND r.status<>'dismissed' LIMIT 1`;

async function currentIssue(recordType: HealthIssueType, recordId: string, userId: string) {
  return env.DB.prepare(recordType === "interaction" ? currentInteractionSql : currentReminderSql)
    .bind(recordId, userId).first<CurrentIssueRow>();
}

export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const checkId = new URL(request.url).searchParams.get("check");
  if (!isHealthIssueCheck(checkId)) return Response.json({ error: "Choose an orphaned interaction or reminder check" }, { status: 422 });
  const recordType: HealthIssueType = checkId === "orphaned-interactions" ? "interaction" : "reminder";
  const sql = recordType === "interaction" ? ORPHANED_INTERACTION_DETAILS_SQL : ORPHANED_REMINDER_DETAILS_SQL;
  try {
    const [records, donors] = await Promise.all([
      env.DB.prepare(sql).bind(profile.id, profile.id).all<OrphanRecordRow>(),
      env.DB.prepare(HEALTH_REPAIR_DONORS_SQL).bind(profile.id).all<DonorSearchRecord>(),
    ]);
    return Response.json({ checkId, issues: records.results.map((row) => toHealthIssue(recordType, row, profile.id)), donors: donors.results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logger.error("data_health_issue_read_failed", error, { userId: profile.id, checkId });
    return Response.json({ error: "Issue details could not be loaded" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as RepairBody | null;
  const recordType = body?.recordType;
  const recordId = body?.recordId?.trim() ?? "";
  if (!body?.confirmed) return Response.json({ error: "Confirm this repair before saving it" }, { status: 422 });
  if ((recordType !== "interaction" && recordType !== "reminder") || !recordId || !isHealthRepairAction(body.action)) return Response.json({ error: "Choose a valid record and repair action" }, { status: 422 });

  const existing = await currentIssue(recordType, recordId, profile.id);
  if (!existing) return Response.json({ error: "This record is no longer available for repair" }, { status: 409 });
  const explanation = explainOrphan(existing, profile.id);
  const stillOrphaned = !existing.linked_donor_id || existing.donor_owner_user_id !== profile.id || existing.donor_data_source !== "live" || existing.donor_archived_at !== null;
  if (!stillOrphaned) return Response.json({ error: "This record is no longer orphaned. Run the health check again." }, { status: 409 });

  let nextDonorId: string | null = null;
  if (body.action === "reattach") {
    nextDonorId = body.targetDonorId?.trim() || null;
    if (!nextDonorId || nextDonorId === existing.donor_id) return Response.json({ error: "Choose a different active donor" }, { status: 422 });
    const target = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(nextDonorId, profile.id).first<{ id: string }>();
    if (!target) return Response.json({ error: "The selected donor is not available in this workspace" }, { status: 404 });
  }
  if (body.action === "move_to_survivor") {
    nextDonorId = explanation.survivingDonorId;
    if (!nextDonorId) return Response.json({ error: "This record does not have a valid surviving donor" }, { status: 409 });
  }
  if (body.action === "dismiss_false_positive" && !explanation.canDismiss) return Response.json({ error: "This issue cannot be dismissed safely; reattach or archive it instead" }, { status: 409 });

  const now = Math.floor(Date.now() / 1000);
  const auditId = crypto.randomUUID();
  const previousState = JSON.stringify({ donorId: existing.donor_id, source: existing.source, status: existing.status });
  const nextState = JSON.stringify({ donorId: nextDonorId ?? existing.donor_id, source: body.action === "archive" && recordType === "interaction" ? `archived:${existing.source ?? "manual"}` : existing.source, status: body.action === "archive" && recordType === "reminder" ? "dismissed" : existing.status });
  const unchangedRecordSql = recordType === "interaction"
    ? "SELECT 1 FROM interactions WHERE id=? AND user_id=? AND donor_id=? AND source=?"
    : "SELECT 1 FROM recommendations WHERE id=? AND user_id=? AND donor_id=? AND status=?";
  const unchangedState = recordType === "interaction" ? existing.source : existing.status;
  const statements = [env.DB.prepare(`INSERT INTO data_health_repair_audits
    (id,user_id,record_type,record_id,action,previous_donor_id,next_donor_id,previous_state_json,next_state_json,reason,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (${unchangedRecordSql})`).bind(auditId, profile.id, recordType, recordId, body.action, existing.donor_id, nextDonorId, previousState, nextState, explanation.whyOrphaned, now, recordId, profile.id, existing.donor_id, unchangedState)];

  if (body.action === "reattach" || body.action === "move_to_survivor") {
    statements.push(env.DB.prepare(`UPDATE ${recordType === "interaction" ? "interactions" : "recommendations"} SET donor_id=?,updated_at=? WHERE id=? AND user_id=? AND donor_id=? AND ${recordType === "interaction" ? "source" : "status"}=?`)
      .bind(nextDonorId, now, recordId, profile.id, existing.donor_id, unchangedState));
  } else if (body.action === "archive" && recordType === "interaction") {
    statements.push(env.DB.prepare("UPDATE interactions SET source=?,updated_at=? WHERE id=? AND user_id=? AND donor_id=? AND source=?")
      .bind(`archived:${existing.source ?? "manual"}`, now, recordId, profile.id, existing.donor_id, unchangedState));
  } else if (body.action === "archive") {
    statements.push(env.DB.prepare("UPDATE recommendations SET status='dismissed',updated_at=? WHERE id=? AND user_id=? AND donor_id=? AND status=?")
      .bind(now, recordId, profile.id, existing.donor_id, unchangedState));
  }

  try {
    const results = await env.DB.batch(statements) as Array<{ meta?: { changes?: number } }>;
    if (results[0]?.meta?.changes === 0 || (statements.length > 1 && results[1]?.meta?.changes === 0)) return Response.json({ error: "This record changed before the repair was saved. Run the health check again." }, { status: 409 });
    const report = await loadDataHealth(profile.id);
    logger.info("data_health_issue_repaired", { userId: profile.id, recordType, recordId, action: body.action, auditId });
    return Response.json({ auditId, report });
  } catch (error) {
    logger.error("data_health_issue_repair_failed", error, { userId: profile.id, recordType, recordId, action: body.action });
    return Response.json({ error: "The repair could not be saved. No repair was applied." }, { status: 500 });
  }
}
