import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import {
  buildDonationRollbackPreview,
  type CurrentGivingActivityRow,
  type DonationImportChangeRow,
} from "../../../../lib/import/donation-rollback";

type ImportRow = {
  id: string;
  file_name: string;
  status: string;
  report_json: string;
  completed_at: number | null;
};

function parseRefreshRange(reportJson: string) {
  try {
    const refresh = (JSON.parse(reportJson) as { refresh?: { rangeStart?: string | null; rangeEnd?: string | null } }).refresh;
    const start = refresh?.rangeStart ? Math.floor(new Date(`${refresh.rangeStart}T00:00:00Z`).getTime() / 1000) : null;
    const end = refresh?.rangeEnd ? Math.floor(new Date(`${refresh.rangeEnd}T00:00:00Z`).getTime() / 1000) : null;
    return { start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null };
  } catch {
    return { start: null, end: null };
  }
}

function isDonationReport(reportJson: string) {
  try {
    return (JSON.parse(reportJson) as { profile?: string }).profile === "JL Solutions Donations";
  } catch {
    return false;
  }
}

async function loadPreview(importId: string, userId: string) {
  const dataImport = await env.DB.prepare(
    "SELECT id, file_name, status, report_json, completed_at FROM data_imports WHERE id = ? AND user_id = ? LIMIT 1",
  ).bind(importId, userId).first<ImportRow>();
  if (!dataImport) return { response: Response.json({ error: "Import not found" }, { status: 404 }) };
  if (dataImport.status !== "completed") {
    return { response: Response.json({ error: "This import has already been reversed or is not complete." }, { status: 409 }) };
  }
  if (!isDonationReport(dataImport.report_json)) {
    return { response: Response.json({ error: "Only JL donation imports can be reversed here." }, { status: 422 }) };
  }

  const completed = await env.DB.prepare(
    "SELECT id, report_json, completed_at FROM data_imports WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC, created_at DESC",
  ).bind(userId).all<{ id: string; report_json: string; completed_at: number | null }>();
  const latestDonation = completed.results.find((row) => isDonationReport(row.report_json));
  if (latestDonation?.id !== importId) {
    return { response: Response.json({ error: "Only the most recent completed donation import can be reversed." }, { status: 409 }) };
  }
  const previousDonation = completed.results.filter((row) => isDonationReport(row.report_json))[1] ?? null;
  const priorRange = previousDonation ? parseRefreshRange(previousDonation.report_json) : { start: null, end: null };

  const priorAudit = await env.DB.prepare(
    "SELECT id FROM donation_import_rollback_audits WHERE import_id = ? LIMIT 1",
  ).bind(importId).first<{ id: string }>();
  if (priorAudit) {
    return { response: Response.json({ error: "This import already has a completed rollback audit." }, { status: 409 }) };
  }

  const changes = await env.DB.prepare(
    "SELECT source_fingerprint, change_type, previous_json FROM giving_activity_import_changes WHERE import_id = ? ORDER BY source_fingerprint",
  ).bind(importId).all<DonationImportChangeRow>();
  const fingerprints = changes.results.map((change) => change.source_fingerprint);
  const current = fingerprints.length
    ? await env.DB.prepare(`SELECT ga.source_fingerprint, ga.donor_id, d.display_name AS donor_name,
        ga.activity_date, COALESCE(ga.committed_cents, ga.paid_cents, 0) AS amount_cents, ga.paid_cents, ga.balance_cents, ga.category,
        ga.description, ga.source_snapshot
      FROM giving_activities ga
      INNER JOIN donors d ON d.id = ga.donor_id AND d.owner_user_id = ga.owner_user_id
      WHERE ga.owner_user_id = ? AND ga.external_source = 'JL Solutions'
        AND ga.source_fingerprint IN (SELECT value FROM json_each(?))`)
      .bind(userId, JSON.stringify(fingerprints)).all<CurrentGivingActivityRow>()
    : { results: [] as CurrentGivingActivityRow[] };
  const preview = buildDonationRollbackPreview(changes.results, current.results);
  return { dataImport, preview, previousRefresh: { completedAt: previousDonation?.completed_at ?? null, ...priorRange } };
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const importId = new URL(request.url).searchParams.get("importId")?.trim() ?? "";
  if (!importId) return Response.json({ error: "Import ID is required" }, { status: 422 });
  const userId = (await ensureUserProfile(user)).id;
  const result = await loadPreview(importId, userId);
  if (result.response) return result.response;
  return Response.json({
    importId,
    batchId: importId,
    fileName: result.dataImport!.file_name,
    completedAt: result.dataImport!.completed_at,
    ...result.preview,
  });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as {
    importId?: string;
    backupConfirmed?: boolean;
    backupId?: string;
    confirmation?: string;
  };
  const importId = body.importId?.trim() ?? "";
  if (!importId) return Response.json({ error: "Import ID is required" }, { status: 422 });
  if (!body.backupConfirmed) {
    return Response.json({ error: "Download and confirm the D1 workspace backup before continuing." }, { status: 422 });
  }
  const backupId = body.backupId?.trim() ?? "";
  if (!backupId) return Response.json({ error: "A verified D1 workspace backup is required." }, { status: 422 });
  if (body.confirmation !== "UNDO") {
    return Response.json({ error: "Type UNDO to confirm this rollback." }, { status: 422 });
  }

  const userId = (await ensureUserProfile(user)).id;
  const backupReceipt = await env.DB.prepare(`SELECT id FROM workspace_backup_audits
    WHERE id = ? AND user_id = ? AND import_id = ? AND purpose = 'donation_rollback' LIMIT 1`)
    .bind(backupId, userId, importId).first<{ id: string }>();
  if (!backupReceipt) return Response.json({ error: "The backup receipt is invalid. Download a fresh backup and try again." }, { status: 409 });
  const result = await loadPreview(importId, userId);
  if (result.response) return result.response;
  const preview = result.preview!;
  if (!preview.safe) {
    return Response.json({ error: "This import cannot be safely reversed.", blockers: preview.blockers }, { status: 409 });
  }

  const inserted = preview.newGifts.map((gift) => gift.sourceFingerprint);
  const restored = preview.restoreStates.map((state) => ({ fingerprint: state.source_fingerprint, ...state }));
  const serializedRestored = JSON.stringify(restored);
  const now = Math.floor(Date.now() / 1000);
  const auditId = crypto.randomUUID();
  const auditPreview = JSON.stringify({
    batchId: importId,
    fileName: result.dataImport!.file_name,
    completedAt: result.dataImport!.completed_at,
    newGifts: preview.newGifts,
    pledgeUpdates: preview.pledgeUpdates,
    totals: preview.totals,
    previousRefresh: result.previousRefresh,
  });
  const statements = [
    env.DB.prepare("DELETE FROM giving_activities WHERE owner_user_id = ? AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))").bind(userId, JSON.stringify(inserted)),
    env.DB.prepare(`UPDATE giving_activities SET
      paid_cents=(SELECT json_extract(value,'$.paid_cents') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint),
      balance_cents=(SELECT json_extract(value,'$.balance_cents') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint),
      category=(SELECT json_extract(value,'$.category') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint),
      source_snapshot=(SELECT json_extract(value,'$.source_snapshot') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint),
      updated_at=? WHERE owner_user_id = ? AND external_source = 'JL Solutions'
      AND source_fingerprint IN (SELECT json_extract(value,'$.fingerprint') FROM json_each(?))`)
      .bind(serializedRestored, serializedRestored, serializedRestored, serializedRestored, now, userId, serializedRestored),
    env.DB.prepare("DELETE FROM jl_payment_assignments WHERE user_id = ? AND applied_import_id = ?").bind(userId, importId),
    env.DB.prepare("UPDATE data_imports SET status = 'rolled_back' WHERE id = ? AND user_id = ? AND status = 'completed'").bind(importId, userId),
    env.DB.prepare(`UPDATE jl_refresh_state SET last_donation_refresh_at = ?, last_donation_range_start = ?,
      last_donation_range_end = ?, updated_at = ? WHERE user_id = ?`)
      .bind(result.previousRefresh!.completedAt, result.previousRefresh!.start, result.previousRefresh!.end, now, userId),
    env.DB.prepare(`INSERT INTO donation_import_rollback_audits
      (id,user_id,import_id,backup_confirmed,preview_json,removed_gifts,restored_pledges,restored_balances,restored_statuses,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(auditId, userId, importId, 1, auditPreview,
      preview.totals.newGiftsRemoved, preview.totals.pledgeUpdatesRestored,
      preview.totals.balancesRestored, preview.totals.statusesRestored, now),
  ];
  try {
    await env.DB.batch(statements);
    logger.info("jl_donation_import_rolled_back", {
      importId,
      userId,
      removed: preview.totals.newGiftsRemoved,
      restored: preview.totals.pledgeUpdatesRestored,
      auditId,
    });
    return Response.json({ importId, auditId, status: "rolled_back", ...preview.totals });
  } catch {
    logger.error("jl_donation_rollback_failed", new Error("Database transaction failed"), { importId, userId });
    return Response.json({ error: "Rollback failed. The transaction was not retained; no partial rollback was kept." }, { status: 500 });
  }
}
